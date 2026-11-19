// fetch() that retries ONLY failures that happen before the request is sent.
//
// Stalwart's first TLS handshake after an idle spell took 11.75 s (oci-mail,
// 2026-11-19; the next ones 0.6-1.1 s). undici aborts a connect after 10 s and
// fetch() rejects with an opaque "fetch failed", so the first, cold JMAP call
// of every mail round trip and reconciliation failed while the same request a
// second later succeeded. Mail was delivered; the read was what broke.
//
// Retried: connect-phase codes only (connect timeout, refused, unreachable,
// DNS). The request body has not left the machine, so a retry can never
// duplicate a write (JMAP Email/set, EmailSubmission/set). A reset or timeout
// AFTER connect is NOT retried: the server may already have acted on it.

const CONNECT_PHASE_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ENOTFOUND",
]);

export function isConnectPhaseError(e: unknown): boolean {
  const cause = (e as { cause?: { code?: string } } | null)?.cause;
  return !!cause?.code && CONNECT_PHASE_CODES.has(cause.code);
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchConnectRetry(
  url: string,
  init: RequestInit = {},
  { attempts = 3, delayMs = 2000, fetchImpl = fetch as FetchFn } = {},
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchImpl(url, init);
    } catch (e) {
      if (attempt >= attempts || !isConnectPhaseError(e)) throw e;
      const code = (e as { cause?: { code?: string } }).cause?.code;
      console.error(`[fetch] ${new URL(url).host} ${code} on attempt ${attempt}/${attempts}; retrying in ${delayMs} ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
