// #1811: which store one /mail/http-to-smtp request delivers to.
// Dependency-free so the per-service tester can import it without node_modules.
//
// No X-Mail-Target header -> the primary (maddy:25, which mirrors to Stalwart),
// so an older Worker or any other caller is unchanged. A named target must be
// declared AND resolved (compose.nix drops targets whose port slug is not in
// cloud-data yet): unknown name -> 400, declared-but-unresolved -> 503.
export interface MailTarget { host: string; port: number }

export interface MailTargets {
  primary: MailTarget;
  targets: Record<string, MailTarget>;
}

export type TargetPick =
  | { ok: true; name: string; host: string; port: number }
  | { ok: false; code: 400 | 503; error: string };

export const DECLARED_TARGETS = ["maddy", "maddy-direct", "stalwart"] as const;

export function pickTarget(header: unknown, mail: MailTargets, declared: readonly string[] = DECLARED_TARGETS): TargetPick {
  const raw = Array.isArray(header) ? header[0] : header;
  const name = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!name) return { ok: true, name: "maddy", host: mail.primary.host, port: mail.primary.port };
  const t = mail.targets[name];
  if (t && t.host && Number.isInteger(t.port)) return { ok: true, name, host: t.host, port: t.port };
  if (declared.includes(name)) return { ok: false, code: 503, error: `mail target '${name}' is declared but not resolved on this host` };
  return { ok: false, code: 400, error: `unknown mail target '${name}'` };
}
