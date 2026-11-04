/**
 * Shell quoting for commands sent over ssh. Pure — no imports — so
 * test-shell-quote.mjs exercises the REAL builders the tools use.
 *
 * Why two quoters: ssh hands the remote command to the account's LOGIN shell,
 * and on oci-apps and oci-mail that is fish, not a POSIX shell. Inside fish
 * single quotes `\'` and `\\` are escapes; in POSIX they are literal. The old
 * wrap (`'` -> `'\''`) is correct for sh but, once a command already carried a
 * quoted `'` (containerExecCmd's own `'\''`), fish read the backslashes as
 * escapes and the quoting fell apart: obs.health.mail_distribution reached
 * sqlite3 as `SELECT inbox_total= || COUNT(*)` (syntax error) and
 * obs.health.mail_ingest's `'  <-- NO MAIL'` became a fish redirect from `--`.
 */

/** Single-quote for a POSIX shell (sh/bash/dash). Not safe for fish. */
export function posixQuote(v: string): string {
  return `'${v.replace(/'/g, "'\\''")}'`;
}

/**
 * Quote one word so POSIX shells AND fish both read it back verbatim.
 * Single-quoted runs never contain `'` or `\` (the only characters the two
 * families treat differently there); those two go in double quotes, where
 * `"'"` and `"\\"` mean the same thing in sh, bash, dash and fish.
 */
export function anyShellQuote(v: string): string {
  if (v === "") return "''";
  return v
    .split(/(['\\])/)
    .filter((p) => p !== "")
    .map((p) => (p === "'" ? `"'"` : p === "\\" ? `"\\\\"` : `'${p}'`))
    .join("");
}

/**
 * Run `command` under bash on the remote, whatever the login shell is. The
 * login shell sees `bash -c <one opaque word>`; bash then parses the body, so
 * callers write POSIX/bash syntax as usual.
 */
export function remoteShellWrap(command: string): string {
  return `bash -c ${anyShellQuote(command)}`;
}

/** `docker exec <container> sh -c <command>` — the body is parsed by bash, so POSIX quoting. */
export function dockerExecShell(container: string, command: string): string {
  return `docker exec ${container} sh -c ${posixQuote(command)}`;
}

/** `sqlite3 -readonly <db> <sql>` with the SQL as ONE quoted word (no "$"/backtick expansion). */
export function sqliteReadonlyCmd(db: string, sql: string): string {
  return `sqlite3 -readonly ${posixQuote(db)} ${posixQuote(sql)}`;
}
