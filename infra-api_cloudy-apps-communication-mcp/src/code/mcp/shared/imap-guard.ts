/**
 * ImapFlow is an EventEmitter and reports a dead socket (e.g. ETIMEOUT after
 * socketTimeout) by emitting "error". With no listener Node treats that as an
 * uncaught exception and kills the WHOLE server: on 2026-11-19 one slow
 * Stalwart login on CPU-starved oci-mail took this MCP down at 03:10, and with
 * restart "no" it stayed down (every mail tool 502, the health round trip
 * unrunnable). The pending command still rejects on its own, so the tool call
 * that hit the timeout fails loudly; the listener only stops the process dying.
 */
export function guardImapErrors(
  client: { on(event: "error", fn: (err: unknown) => void): unknown },
  label: string,
): void {
  client.on("error", (err: unknown) => {
    const msg = err instanceof Error ? `${(err as { code?: string }).code ?? err.name}: ${err.message}` : String(err);
    console.error(`[imap ${label}] connection error (tool call fails, server stays up): ${msg}`);
  });
}
