// redact-argv.ts — strip secrets out of command lines before a tool prints them.
//
// Why (2026-10-10): devops.docker.inspect redacted Config.Env but printed
// Config.Cmd verbatim, and kg-store / kg-store-pub ran
//   surreal start --user root --pass <root password> ...
// so both SurrealDB root passwords landed in an agent session's tool output.
// Env redaction alone is not enough: a secret is just as often an argv word.
//
// Covered shapes (each redacts the VALUE, keeps the flag so the output stays
// readable):
//   --pass X  --password=X  --token X  --secret X  --api-key X  ...  (split or =)
//   -p X  (unless X looks like a port: 8080, 8080:80, 53/udp)  and -pXXXX (mysql)
//   NAME_PASSWORD=X / FOO_TOKEN=X assignments inside an argv word or sh -c string
//   scheme://user:PASS@host URL credentials
// Over-redaction is acceptable in a diagnostic view; a leak is not.

export const REDACTED = "***REDACTED***";

const SECRET_FLAG = String.raw`(?:pass|password|passwd|passphrase|pwd|token|auth-?token|access-?token|bearer|secret|client-?secret|api-?key|apikey|access-?key|secret-?key|private-?key|credentials?)`;
const LONG_FLAG_RE = new RegExp(String.raw`^--?${SECRET_FLAG}$`, "i");
const LONG_FLAG_EQ_RE = new RegExp(String.raw`^(--?${SECRET_FLAG}=)(.+)$`, "i");
const PORTISH_RE = /^\d{1,5}(?::\d{1,5})?(?:\/(?:tcp|udp))?$/;
const ATTACHED_P_RE = /^-p([^-\s].{3,})$/; // mysql -pSECRET; >=4 chars so -pv etc. survive
const ENV_ASSIGN_RE = /\b([A-Za-z_][A-Za-z0-9_]*(?:PASSWORD|PASSWD|PASS|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Za-z0-9_]*=)("[^"]*"|'[^']*'|[^\s"';]+)/gi;
const URL_CRED_RE = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s@/]+)(@)/gi;
const INLINE_FLAG_RE = new RegExp(String.raw`(^|\s)(--?${SECRET_FLAG}(?:=|\s+))("[^"]*"|'[^']*'|[^\s"']+)`, "gi");
const INLINE_P_RE = /(^|\s)(-p\s+)("[^"]*"|'[^']*'|[^\s"'-][^\s"']*)/g;

/** Redact secrets inside ONE free-form string (an argv word, a sh -c script, a ps line). */
export function redactCommandString(s: string): string {
  if (typeof s !== "string" || s === "") return s;
  let out = s.replace(URL_CRED_RE, (_m, a, _p, c) => `${a}${REDACTED}${c}`);
  out = out.replace(INLINE_FLAG_RE, (_m, lead, flag) => `${lead}${flag}${REDACTED}`);
  out = out.replace(INLINE_P_RE, (m, lead, flag, val) =>
    PORTISH_RE.test(val.replace(/^["']|["']$/g, "")) ? m : `${lead}${flag}${REDACTED}`);
  out = out.replace(ENV_ASSIGN_RE, (_m, name) => `${name}${REDACTED}`);
  return out;
}

/** Redact an argv array (Config.Cmd / Config.Entrypoint / Args / Healthcheck.Test). */
export function redactArgv(argv: unknown): unknown {
  if (!Array.isArray(argv)) return typeof argv === "string" ? redactCommandString(argv) : argv;
  const out: unknown[] = [];
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i];
    if (typeof w !== "string") { out.push(w); continue; }
    const prev = i > 0 ? argv[i - 1] : undefined;
    if (typeof prev === "string" && LONG_FLAG_RE.test(prev)) { out.push(REDACTED); continue; }
    if (prev === "-p" && !PORTISH_RE.test(w)) { out.push(REDACTED); continue; }
    const eq = w.match(LONG_FLAG_EQ_RE);
    if (eq) { out.push(`${eq[1]}${REDACTED}`); continue; }
    if (ATTACHED_P_RE.test(w) && !PORTISH_RE.test(w.slice(2))) { out.push(`-p${REDACTED}`); continue; }
    out.push(redactCommandString(w));
  }
  return out;
}

/** Redact every argv-bearing field of one `docker inspect` object, in place. */
export function redactInspectArgv(item: any): void {
  if (!item || typeof item !== "object") return;
  if ("Args" in item) item.Args = redactArgv(item.Args);
  if (typeof item.Path === "string") item.Path = redactCommandString(item.Path);
  const cfg = item.Config;
  if (cfg && typeof cfg === "object") {
    if ("Cmd" in cfg) cfg.Cmd = redactArgv(cfg.Cmd);
    if ("Entrypoint" in cfg) cfg.Entrypoint = redactArgv(cfg.Entrypoint);
    if (cfg.Healthcheck && "Test" in cfg.Healthcheck) cfg.Healthcheck.Test = redactArgv(cfg.Healthcheck.Test);
    if (cfg.Labels && typeof cfg.Labels === "object") {
      for (const k of Object.keys(cfg.Labels)) cfg.Labels[k] = redactCommandString(String(cfg.Labels[k]));
    }
  }
}
