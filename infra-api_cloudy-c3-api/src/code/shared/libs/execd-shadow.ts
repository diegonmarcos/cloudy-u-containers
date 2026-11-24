// execd-shadow.ts — shadow stage of ticket #1875 (Go c3-execd sidecar).
//
// Pure (import-free) so `node test-execd-shadow.ts` loads the real code. When
// C3_EXECD_URL is set, ssh.ts replays a call to the sidecar AFTER the legacy path has
// answered and logs whether both agree. Only commands that are provably read-only and
// idempotent are replayed (a replayed `docker restart` would restart twice); the legacy
// result is always what the caller gets. With C3_EXECD_URL unset nothing happens.

export interface ShadowResult { stdout: string; stderr: string; exitCode: number; ok: boolean; timedOut: boolean }

// Whole-command allowlist. Anchored, no shell metacharacters beyond what each pattern names.
const SAFE_SSH: RegExp[] = [
  /^echo ok$/,
  /^docker ps(?: -a)?(?: --format "[^"`$\\]*")?$/,
  /^docker (?:info|version)$/,
  /^docker inspect(?: --format "[^"`$\\]*")? [a-zA-Z0-9_.-]+$/,
  /^uptime$/,
  /^hostname$/,
];

export function isShadowSafe(command: string): boolean {
  return SAFE_SSH.some((re) => re.test(command));
}

/** Fields that must agree between the legacy and the sidecar answer. `echo ok` and friends are
 * deterministic, so stdout is compared for them; the volatile ones (ps, info, uptime) compare
 * only the outcome. */
const STDOUT_STABLE: RegExp[] = [/^echo ok$/, /^hostname$/];

export function shadowDiff(command: string, legacy: ShadowResult, sidecar: ShadowResult): string[] {
  const d: string[] = [];
  if (legacy.ok !== sidecar.ok) d.push(`ok ${legacy.ok} != ${sidecar.ok}`);
  if (legacy.exitCode !== sidecar.exitCode) d.push(`exitCode ${legacy.exitCode} != ${sidecar.exitCode}`);
  if (legacy.timedOut !== sidecar.timedOut) d.push(`timedOut ${legacy.timedOut} != ${sidecar.timedOut}`);
  if (STDOUT_STABLE.some((re) => re.test(command)) && legacy.stdout !== sidecar.stdout) d.push("stdout differs");
  return d;
}

export const shadowStats = { replayed: 0, match: 0, mismatch: 0, error: 0 };

export function shadowLine(alias: string, command: string, diffs: string[]): string {
  return diffs.length === 0
    ? `[execd-shadow] MATCH ${alias}: "${command.slice(0, 60)}"`
    : `[execd-shadow] MISMATCH ${alias}: "${command.slice(0, 60)}" ${diffs.join("; ")}`;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Fire-and-forget replay; never throws, never delays the caller. */
export function shadowSsh(
  alias: string,
  command: string,
  timeoutMs: number,
  legacy: ShadowResult,
  opts: { url?: string; token?: string; fetch?: Fetch; log?: (l: string) => void } = {},
): Promise<void> {
  const url = opts.url ?? process.env.C3_EXECD_URL;
  if (!url || !isShadowSafe(command)) return Promise.resolve();
  const log = opts.log ?? ((l: string) => process.stderr.write(l + "\n"));
  const f = (opts.fetch ?? (globalThis.fetch as unknown as Fetch));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs + 5_000);
  shadowStats.replayed++;
  return f(`${url}/v1/ssh`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-execd-token": opts.token ?? process.env.C3_EXECD_TOKEN ?? "" },
    body: JSON.stringify({ alias, command, timeout_ms: timeoutMs }),
    signal: ac.signal,
  })
    .then(async (r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const side = (await r.json()) as ShadowResult;
      const diffs = shadowDiff(command, legacy, side);
      if (diffs.length === 0) shadowStats.match++; else shadowStats.mismatch++;
      log(shadowLine(alias, command, diffs));
    })
    .catch((e: unknown) => {
      shadowStats.error++;
      log(`[execd-shadow] ERROR ${alias}: ${(e as Error).message}`);
    })
    .finally(() => clearTimeout(timer));
}
