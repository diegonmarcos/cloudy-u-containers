/**
 * Pure helpers behind devops.caddy.cert_repair. No imports, no ssh, no fs — so
 * test-caddy-cert-repair.mjs exercises the REAL script builder and parsers.
 *
 * Incident 2026-10-15: overlapping deploys left caddy on gcp-proxy in a restart
 * loop — "caching certificate: tls: private key does not match public key" for
 * mesh-CA certs (c3-services-mcp.mesh.diegonmarcos.com, filebrowser.mesh.diegonmarcos.com, photoprism.mesh.diegonmarcos.com). While
 * caddy crash-loops `docker exec` is useless, so the repair works on the HOST
 * side of the /data mount: move the cert dirs whose .key does not match the
 * .crt out of <data>/caddy/certificates/ (caddy then re-issues), restart caddy.
 * Nothing is deleted; moved dirs keep their files under <data>/caddy/bad-cert-*.
 */

export const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
/** Host path of the /data mount source: absolute, no spaces/quotes/`..`. */
const HOST_PATH_RE = /^\/[A-Za-z0-9_.\/-]+$/;
export const MISMATCH_RE = /private key does not match/i;

/** `docker inspect` template printing the host source of the container's /data mount. */
export const DATA_MOUNT_TEMPLATE = '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}';

/** Validate the mount source printed by docker inspect; null when unusable. */
export function parseDataMount(stdout: string): string | null {
  const p = stdout.trim();
  if (!HOST_PATH_RE.test(p) || p.split("/").includes("..") || p === "/") return null;
  return p.replace(/\/+$/, "");
}

/** Timestamp for bad-cert-<name>-<ts> dir names: UTC, filesystem-safe. */
export function tsStamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export type CertStatus = "running" | "complete" | "stale";

/** Max age (s) of a scan result that may be returned / acted on. */
export const RESULT_MAX_AGE_SEC = 600;
/** Hard cap (s) on one detached scan; the host kills it after this. */
const SCAN_CAP_SEC = 1500;
/** "<issuer>/<name>" exactly as the scan emits it; safe to hand back to a shell. */
export const CERT_RE = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*\/[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;

export interface ScanResult {
  data: string; started: number; finished: number;
  /** cert dirs actually probed with openssl / matching / skipped because unchanged since the last good scan. */
  checked: number; ok: number; unchanged: number; incremental: boolean;
  bad: string[]; skip: { cert: string; why: string }[]; mesh: number; err: string | null;
}

export interface Parsed {
  status: CertStatus | null; started: boolean;
  age: number | null; startedAgo: number | null; prevAge: number | null;
  result: ScanResult | null;
  moved: { cert: string; to: string }[]; leftInPlace: string[];
  mesh: number | null; meshMoved: string | null; restarting: boolean; data: string | null; errs: string[];
}

const SCAN_PROBE = [
  // pair DIR: sets CRT/KEY, or WHY + return 2. cmp: 0 match, 1 mismatch, 2 unreadable (WHY set).
  'pair() { local c; CRT=""; for c in "$1"/*.crt; do [ -f "$c" ] && { CRT="$c"; break; }; done',
  '  [ -n "$CRT" ] || { WHY="no .crt"; return 2; }; KEY="${CRT%.crt}.key"; [ -f "$KEY" ] || { WHY="no .key"; return 2; }; }',
  'cmp_pair() { local pa pb; pa=$(openssl x509 -in "$CRT" -noout -pubkey 2>/dev/null); pb=$(openssl pkey -in "$KEY" -pubout 2>/dev/null)',
  '  if [ -z "$pa" ] || [ -z "$pb" ]; then WHY="unreadable cert or key"; return 2; fi; [ "$pa" = "$pb" ]; }',
];

function checkState(stateDir: string): void {
  if (!HOST_PATH_RE.test(stateDir) || stateDir.split("/").includes("..")) throw new Error(`Invalid state dir: ${stateDir}`);
}

/**
 * The DETACHED scan (run as root: `bash <script> <dataDir>`). It takes a lock (mkdir), probes every
 * <data>/caddy/certificates/<issuer>/<name> and finally publishes <stateDir>/caddy-cert-scan.json
 * atomically (the file's appearance == scan complete) plus caddy-cert-scan.bad (one mismatched
 * "issuer/name" per line). Dirs whose .crt AND .key are older than the last good scan
 * (caddy-cert-scan.good, same data dir) are not probed again: they stay bad iff they were bad.
 * Only names/mismatch flags are written; no key material.
 */
export function buildScanScript(o: { stateDir?: string }): string {
  const sd = o.stateDir ?? "/var/tmp";
  checkState(sd);
  return [
    "set -u",
    `SD='${sd}'; J="$SD/caddy-cert-scan.json"; BADF="$SD/caddy-cert-scan.bad"; MARK="$SD/caddy-cert-scan.good"; L="$SD/caddy-cert-scan.lock"`,
    'D="${1:-}"; START=$(date +%s); WHY=""',
    'fail() { e=$(printf %s "$1" | tr -d \'"\\\\\' | head -c 200); printf \'{"v":1,"err":"%s","started":%s,"finished":%s}\\n\' "$e" "$START" "$(date +%s)" > "$J.tmp" && mv -f "$J.tmp" "$J"; exit 1; }',
    'if ! mkdir "$L" 2>/dev/null; then',
    '  op=$(cat "$L/pid" 2>/dev/null)',
    '  if [ -n "$op" ] && grep -q caddy-cert-scan "/proc/$op/cmdline" 2>/dev/null; then exit 0; fi',
    '  rm -rf -- "$L"; mkdir "$L" 2>/dev/null || exit 0',
    "fi",
    'echo $$ > "$L/pid"; trap \'rm -rf -- "$L"; rm -f -- "$MARK.new" "$BADF.new"\' EXIT',
    'if [[ ! "$D" =~ ^/[A-Za-z0-9_./-]+$ ]] || [[ "$D" == *..* ]]; then fail "no usable /data mount"; fi',
    'ROOT="$D/caddy/certificates"',
    'command -v openssl >/dev/null 2>&1 || fail "openssl not installed on the host"',
    '[ -d "$ROOT" ] || fail "no certificates dir at $ROOT"',
    ...SCAN_PROBE,
    'INC=0; [ -f "$MARK" ] && [ "$(cat "$MARK" 2>/dev/null)" = "$D" ] && INC=1',
    'printf %s "$D" > "$MARK.new"; : > "$BADF.new"',
    "okn=0; unch=0; chk=0; bads=''; skips=''",
    'for idir in "$ROOT"/*/; do',
    '  [ -d "$idir" ] || continue',
    '  iss="${idir%/}"; iss="${iss##*/}"',
    '  for d in "$idir"*/; do',
    '    [ -d "$d" ] || continue',
    '    name="${d%/}"; name="${name##*/}"',
    '    case "$iss" in \'\'|[!A-Za-z0-9_]*|*[!A-Za-z0-9_.+-]*) continue;; esac',
    '    case "$name" in \'\'|[!A-Za-z0-9_]*|*[!A-Za-z0-9_.+-]*) skips="$skips${skips:+,}{\\"cert\\":\\"$iss/_\\",\\"why\\":\\"odd dir name\\"}"; continue;; esac',
    '    cert="$iss/$name"',
    '    if ! pair "${d%/}"; then skips="$skips${skips:+,}{\\"cert\\":\\"$cert\\",\\"why\\":\\"$WHY\\"}"; continue; fi',
    '    if [ "$INC" = 1 ] && [ "$CRT" -ot "$MARK" ] && [ "$KEY" -ot "$MARK" ]; then',
    '      if grep -qxF -- "$cert" "$BADF" 2>/dev/null; then bads="$bads${bads:+,}\\"$cert\\""; echo "$cert" >> "$BADF.new"; else okn=$((okn+1)); fi',
    "      unch=$((unch+1)); continue",
    "    fi",
    "    chk=$((chk+1)); cmp_pair; rc=$?",
    '    if [ "$rc" = 0 ]; then okn=$((okn+1))',
    '    elif [ "$rc" = 1 ]; then bads="$bads${bads:+,}\\"$cert\\""; echo "$cert" >> "$BADF.new"',
    '    else skips="$skips${skips:+,}{\\"cert\\":\\"$cert\\",\\"why\\":\\"$WHY\\"}"; fi',
    "  done",
    "done",
    'mesh=0; [ -d "$ROOT/mesh" ] && mesh=$(find "$ROOT/mesh" -mindepth 1 -maxdepth 1 | wc -l)',
    'mv -f "$BADF.new" "$BADF"; mv -f "$MARK.new" "$MARK"',
    'printf \'{"v":1,"data":"%s","started":%s,"finished":%s,"checked":%s,"ok":%s,"unchanged":%s,"incremental":%s,"bad":[%s],"skip":[%s],"mesh":%s}\\n\' "$D" "$START" "$(date +%s)" "$chk" "$okn" "$unch" "$([ "$INC" = 1 ] && echo true || echo false)" "$bads" "$skips" "$mesh" > "$J.tmp" && mv -f "$J.tmp" "$J"',
  ].join("\n");
}

/**
 * The CONTROL script, ONE ssh as root, always fast (<10s). Without `allMesh`:
 *  - fresh result (<= maxAgeSec): print it (`STATUS complete`); live run additionally moves ONLY the
 *    certs of that result (re-probed first), then async-restarts the container and clears the result;
 *  - else scan running: `STATUS running`;
 *  - else starts the detached scan (nohup/setsid/nice, lock inside the scan): `STATUS running` + `STARTED`;
 *    `STATUS stale` if it cannot be started.
 * `allMesh` is synchronous and needs no scan (find + mv): it quarantines the whole certificates/mesh dir.
 * A dry run with a container appends state + recent logs after `===LOGS===`.
 */
export function buildRepairScript(o: { dataDir?: string; container?: string; allMesh: boolean; dryRun: boolean; ts: string; stateDir?: string; maxAgeSec?: number }): string {
  if (o.dataDir !== undefined && (!HOST_PATH_RE.test(o.dataDir) || o.dataDir.split("/").includes(".."))) throw new Error(`Invalid data dir: ${o.dataDir}`);
  if (o.dataDir === undefined && !o.container) throw new Error("Invalid data dir: need dataDir or container");
  if (o.container !== undefined && !CONTAINER_RE.test(o.container)) throw new Error(`Invalid container: ${o.container}`);
  if (!/^[0-9]{8}T[0-9]{6}Z$/.test(o.ts)) throw new Error(`Invalid timestamp: ${o.ts}`);
  const sd = o.stateDir ?? "/var/tmp";
  checkState(sd);
  const maxAge = Math.max(1, Math.min(Math.floor(o.maxAgeSec ?? RESULT_MAX_AGE_SEC), 3600));
  const c = o.container;
  const scanB64 = Buffer.from(buildScanScript({ stateDir: sd })).toString("base64");
  return [
    "set -u",
    `SD='${sd}'; D='${o.dataDir ?? ""}'; TS='${o.ts}'; ALL=${o.allMesh ? 1 : 0}; DRY=${o.dryRun ? 1 : 0}; MAXAGE=${maxAge}`,
    'J="$SD/caddy-cert-scan.json"; BADF="$SD/caddy-cert-scan.bad"; L="$SD/caddy-cert-scan.lock"; S="$SD/caddy-cert-scan.sh"; WHY=""',
    ...(c ? [`[ -n "$D" ] || D=$(docker inspect -f '${DATA_MOUNT_TEMPLATE}' ${c} 2>/dev/null)`] : []),
    'D="${D%/}"',
    'if [[ ! "$D" =~ ^/[A-Za-z0-9_./-]+$ ]] || [[ "$D" == *..* ]]; then echo "ERR no usable /data mount (got: ${D:0:80})"; echo "STATUS stale"; exit 5; fi',
    'echo "DATA $D"',
    'ROOT="$D/caddy/certificates"',
    'command -v openssl >/dev/null 2>&1 || { echo "ERR openssl not installed on the host"; echo "STATUS stale"; exit 3; }',
    '[ -d "$ROOT" ] || { echo "ERR no certificates dir at $ROOT"; echo "STATUS stale"; exit 4; }',
    ...SCAN_PROBE,
    'age_of() { [ -e "$1" ] && echo $(( $(date +%s) - $(stat -c %Y "$1") )) || echo -1; }',
    "tail_info() {",
    '  if [ "$DRY" = 1 ]; then',
    ...(c ? [`    echo "STATE $(docker inspect -f '${STATE_TEMPLATE}' ${c} 2>&1)"`, '    echo "===LOGS==="', `    timeout 8 docker logs --tail 400 ${c} 2>&1`] : ["    :"]),
    "  else",
    ...(c ? [`    nohup docker restart -t 5 ${c} >/dev/null 2>&1 </dev/null &`, '    echo "RESTARTING"'] : ["    :"]),
    "  fi",
    "}",
    'if [ "$ALL" = 1 ]; then',
    '  echo "STATUS complete"',
    '  if [ -d "$ROOT/mesh" ]; then',
    '    echo "MESH $(find "$ROOT/mesh" -mindepth 1 -maxdepth 1 | wc -l)"',
    '    if [ "$DRY" = 0 ]; then',
    '      if mv -- "$ROOT/mesh" "$D/caddy/bad-cert-mesh-$TS"; then echo "MESH_MOVED $D/caddy/bad-cert-mesh-$TS"; else echo "ERR could not move $ROOT/mesh"; fi',
    "    fi",
    '  else echo "MESH 0"; fi',
    "  tail_info; exit 0",
    "fi",
    'age=$(age_of "$J")',
    'if [ "$age" -ge 0 ] && [ "$age" -le "$MAXAGE" ]; then',
    '  echo "STATUS complete"; echo "AGE $age"; echo "RESULT $(tr -d \'\\n\' < "$J")"',
    '  if [ "$DRY" = 0 ]; then',
    '    while IFS= read -r cert; do',
    '      [[ "$cert" =~ ^[A-Za-z0-9_][A-Za-z0-9_.+-]*/[A-Za-z0-9_][A-Za-z0-9_.+-]*$ ]] || continue',
    '      d="$ROOT/$cert"; name="${cert##*/}"',
    '      [ -d "$d" ] || { echo "LEFT $cert gone already"; continue; }',
    '      if pair "$d"; then cmp_pair; rc=$?; else rc=2; fi',
    '      if [ "$rc" != 1 ]; then echo "LEFT $cert $([ "$rc" = 0 ] && echo "key matches now" || echo "not verifiable now")"; continue; fi',
    '      dst="$D/caddy/bad-cert-$name-$TS"; [ -e "$dst" ] && dst="$dst-${cert%%/*}"',
    '      if mv -- "$d" "$dst"; then echo "MOVED $cert $dst"; else echo "ERR could not move $cert"; fi',
    '    done < "$BADF"',
    '    : > "$BADF"; rm -f -- "$J"',
    "  fi",
    "  tail_info; exit 0",
    "fi",
    'if [ -d "$L" ]; then',
    '  p=$(cat "$L/pid" 2>/dev/null)',
    '  if [ -n "$p" ] && grep -q caddy-cert-scan "/proc/$p/cmdline" 2>/dev/null; then',
    '    echo "STATUS running"; echo "STARTED_AGO $(age_of "$L")"; [ "$age" -ge 0 ] && echo "PREV_AGE $age"; exit 0',
    "  fi",
    "fi",
    `printf %s '${scanB64}' | base64 -d > "$S" 2>/dev/null || { echo "ERR could not write $S"; echo "STATUS stale"; [ "$age" -ge 0 ] && echo "PREV_AGE $age"; exit 6; }`,
    `nohup setsid nice -n 19 timeout ${SCAN_CAP_SEC} bash "$S" "$D" </dev/null >/dev/null 2>&1 &`,
    'echo "STATUS running"; echo "STARTED"; [ "$age" -ge 0 ] && echo "PREV_AGE $age"; exit 0',
  ].join("\n");
}

function emptyParsed(): Parsed {
  return { status: null, started: false, age: null, startedAgo: null, prevAge: null, result: null, moved: [], leftInPlace: [], mesh: null, meshMoved: null, restarting: false, data: null, errs: [] };
}

/** Validate the scan's JSON (host-written, but never trusted): drops malformed certs. */
export function parseResult(json: string): ScanResult | null {
  let j: Record<string, unknown>;
  try { j = JSON.parse(json) as Record<string, unknown>; } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const skip = Array.isArray(j.skip) ? (j.skip as unknown[]).flatMap((s) => {
    const o = s as { cert?: unknown; why?: unknown };
    return o && typeof o.cert === "string" && typeof o.why === "string" ? [{ cert: o.cert.slice(0, 200), why: o.why.slice(0, 100) }] : [];
  }) : [];
  return {
    data: typeof j.data === "string" ? j.data : "", started: num(j.started), finished: num(j.finished),
    checked: num(j.checked), ok: num(j.ok), unchanged: num(j.unchanged), incremental: j.incremental === true,
    bad: Array.isArray(j.bad) ? (j.bad as unknown[]).filter((b): b is string => typeof b === "string" && CERT_RE.test(b)) : [],
    skip, mesh: num(j.mesh), err: typeof j.err === "string" ? j.err : null,
  };
}

export function parseScanOutput(out: string): Parsed {
  const p = emptyParsed();
  for (const raw of out.split("\n")) {
    const l = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^STATUS (running|complete|stale)$/.exec(l))) p.status = m[1] as CertStatus;
    else if (l === "STARTED") p.started = true;
    else if ((m = /^AGE (\d+)$/.exec(l))) p.age = Number(m[1]);
    else if ((m = /^STARTED_AGO (\d+)$/.exec(l))) p.startedAgo = Number(m[1]);
    else if ((m = /^PREV_AGE (\d+)$/.exec(l))) p.prevAge = Number(m[1]);
    else if ((m = /^RESULT (\{.*\})$/.exec(l))) p.result = parseResult(m[1]);
    else if ((m = /^MOVED (\S+) (\S+)$/.exec(l))) p.moved.push({ cert: m[1], to: m[2] });
    else if ((m = /^LEFT (\S+) (.+)$/.exec(l))) p.leftInPlace.push(`${m[1]} (${m[2]})`);
    else if ((m = /^MESH (\d+)$/.exec(l))) p.mesh = Number(m[1]);
    else if ((m = /^MESH_MOVED (\S+)$/.exec(l))) p.meshMoved = m[1];
    else if (l === "RESTARTING") p.restarting = true;
    else if ((m = /^DATA (\S+)$/.exec(l))) p.data = m[1];
    else if ((m = /^ERR (.+)$/.exec(l))) p.errs.push(m[1]);
  }
  return p;
}

/** "issuer/name" -> name (the domain). */
export const certDomain = (cert: string): string => cert.slice(cert.indexOf("/") + 1);

/** Lines of `docker logs` that report a key/cert mismatch (trimmed, capped). */
export function mismatchLines(logs: string, max = 10): string[] {
  return logs.split("\n").map((l) => l.trim()).filter((l) => MISMATCH_RE.test(l)).slice(0, max).map((l) => l.slice(0, 400));
}

/** Domains named in mismatch lines: JSON `"identifier"`/`"subject"` fields, else any hostname-looking token. */
export function mismatchDomains(logs: string): string[] {
  const found = new Set<string>();
  for (const l of mismatchLines(logs, 200)) {
    for (const m of l.matchAll(/(?:identifier|subject|domain|name|certificate)["']?\s*[:=]\s*["']?([A-Za-z0-9*_.-]+\.[A-Za-z]{2,})/g)) found.add(m[1].toLowerCase());
    for (const m of l.matchAll(/\b((?:[a-z0-9_-]+\.)+[a-z]{2,})\b/gi)) {
      const h = m[1].toLowerCase();
      if (!/^(tls|caddy|http|cache|golang)\./.test(h) && !h.endsWith(".go")) found.add(h);
    }
  }
  return [...found];
}

function summarize(line: string): string {
  const t = line.trim();
  if (t.startsWith("{")) {
    try {
      const j = JSON.parse(t) as Record<string, unknown>;
      const parts = [j.level, j.logger, j.msg, j.error].filter((v) => typeof v === "string" && v).map(String);
      if (parts.length) return parts.join(" | ").slice(0, 500);
    } catch { /* not JSON — fall through */ }
  }
  return t.slice(0, 500);
}

const ERR_LINE_RE = /^Error:|"level"\s*:\s*"(error|fatal|panic)"|\b(error|fatal)\b/i;

/**
 * Caddy's last error mentioning `domain` (case-insensitive), or — with no
 * domain — its last startup error. null when the logs hold none.
 */
export function lastStartupError(logs: string, domain?: string): string | null {
  const d = domain?.toLowerCase();
  const lines = logs.split("\n").filter((l) => l.trim() && ERR_LINE_RE.test(l) && (!d || l.toLowerCase().includes(d)));
  return lines.length ? summarize(lines[lines.length - 1]) : null;
}

export interface ContainerState { status: string; restarting: boolean; restartCount: number; startedAt: string }

/** Parse `docker inspect -f '{{.State.Status}}|{{.State.Restarting}}|{{.RestartCount}}|{{.State.StartedAt}}'`. */
export function parseState(out: string): ContainerState | null {
  const m = /^(\S+)\|(true|false)\|(\d+)\|(\S+)$/.exec(out.trim());
  return m ? { status: m[1], restarting: m[2] === "true", restartCount: Number(m[3]), startedAt: m[4] } : null;
}

export const STATE_TEMPLATE = "{{.State.Status}}|{{.State.Restarting}}|{{.RestartCount}}|{{.State.StartedAt}}";

export interface RepairReport {
  vm: string; container: string; dataDir: string; dryRun: boolean; allMesh: boolean;
  scan: Parsed; restarted: string | null; state: ContainerState | null; remaining: string[]; startupErrors: { domain: string; error: string | null }[]; lastError: string | null;
}

const mins = (s: number): string => (s < 90 ? `${s}s` : `${Math.round(s / 60)} min`);

/** Human report. Always opens with `status: running|complete|stale`; says "nothing to repair" exactly when a complete scan found no mismatch. */
export function formatReport(r: RepairReport): string {
  const sc = r.scan;
  const res = sc.result;
  const status: CertStatus = sc.status ?? "stale";
  const out: string[] = [
    `caddy cert repair: ${r.container}@${r.vm}  (${r.dryRun ? "DRY RUN" : "LIVE"}${r.allMesh ? ", all_mesh" : ""})`,
    `status: ${status}`,
    `/data host source: ${r.dataDir}`,
  ];
  for (const e of sc.errs) out.push(`  ERROR ${e}`);
  if (sc.prevAge !== null) out.push(`previous scan result is ${mins(sc.prevAge)} old (> ${mins(RESULT_MAX_AGE_SEC)}): stale, not used`);
  if (r.allMesh) {
    out.push(`mesh dir: ${sc.mesh ?? 0} entries${sc.meshMoved ? ` -> moved to ${sc.meshMoved}` : r.dryRun && sc.mesh ? " (would move whole dir)" : ""}`);
  } else if (status === "running") {
    out.push(sc.started
      ? "scan started on the host (detached, nice'd; a small VM needs a few minutes). Call again in ~2 min for the result."
      : `scan still running (${mins(sc.startedAgo ?? 0)} so far). Call again shortly.`);
    return out.join("\n");
  } else if (status === "stale") {
    out.push("no usable scan result and the scan could not be started");
    return out.join("\n");
  } else if (res) {
    if (res.err) out.push(`  SCAN ERROR ${res.err}`);
    else {
      out.push(`scan finished ${mins(sc.age ?? 0)} ago, took ${Math.max(0, res.finished - res.started)}s${res.incremental ? ` (incremental: ${res.unchanged} unchanged dirs not re-probed)` : " (full)"}`);
      out.push(`checked ${res.ok + res.bad.length} cert dirs: ${res.ok} match, ${res.bad.length} mismatched, ${res.skip.length} skipped`);
      for (const b of res.bad) out.push(`  MISMATCH ${b}${r.dryRun ? " (would move)" : ""}`);
      for (const s of res.skip) out.push(`  skipped ${s.cert}: ${s.why}`);
    }
  }
  for (const m of sc.moved) out.push(`  moved ${m.cert} -> ${m.to}`);
  for (const l of sc.leftInPlace) out.push(`  left in place ${l}`);
  const nBad = res?.bad.length ?? 0;
  const toRepair = nBad > 0 || (r.allMesh && (sc.mesh ?? 0) > 0);
  if (!r.allMesh && res && !res.err && nBad === 0 && !sc.errs.length) out.push("nothing to repair: every cert key matches its certificate");
  else if (r.dryRun && toRepair) out.push("dry_run=true: nothing was moved or restarted. Re-run with dry_run=false to repair (acts on this result while it is < 10 min old).");
  if (r.restarted) out.push(`restart: ${r.restarted}`);
  if (r.state) out.push(`container: ${r.state.status}${r.state.restarting ? " (restarting)" : ""}, restart count ${r.state.restartCount}`);
  if (r.restarted && !r.dryRun) return out.join("\n");
  out.push(r.remaining.length ? `remaining "private key does not match" log lines (${r.remaining.length}):` : 'no remaining "private key does not match" log lines');
  for (const l of r.remaining) out.push(`  ${l}`);
  for (const s of r.startupErrors) out.push(`last log error for ${s.domain}: ${s.error ?? "(none)"}`);
  out.push(`last startup error: ${r.lastError ?? "(none)"}`);
  return out.join("\n");
}
