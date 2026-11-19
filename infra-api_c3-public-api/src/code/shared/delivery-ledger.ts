// #1819: one SMTP delivery per message, however often the caller retries.
// Dependency-free so the per-service tester can import it without node_modules.
//
// Why: oci-mail (E2.1.Micro) answers slowly under swap and CPU steal. maddy
// accepted messages AFTER the bridge's response deadline, the bridge answered
// 500, the CF Worker retried, and every retry opened a NEW SMTP session: each
// mail was stored two or three times (2026-11-19, 9 of 9 bridge deliveries
// "failed" in an hour while maddy logged them all accepted).
//
// How: the SMTP session runs on its own (long) socket timeouts and is not tied
// to the HTTP response. The response waits at most `waitMs`; if the session is
// still running the caller gets "pending" (the route answers 504). A retry with
// the same key joins the session already in flight instead of starting one,
// and a retry after success is answered "delivered" without sending again.
// A failed session is forgotten, so the next retry really sends again.
//
// Key = target + Message-ID + recipient. A message without a Message-ID is
// never deduplicated (no stable key): it keeps the old one-try-one-send shape.

export type LedgerResult =
  | { state: "delivered"; deduped: boolean }
  | { state: "pending"; joined: boolean }
  | { state: "failed"; error: string };

interface Entry {
  promise: Promise<void>;
  state: "pending" | "delivered" | "failed";
  error?: string;
  at: number;
}

export interface DeliveryLedger {
  deliver(key: string | null, send: () => Promise<void>, waitMs: number): Promise<LedgerResult>;
  size(): number;
}

export function ledgerKey(target: string, msgId: string | null | undefined, rcpt: string): string | null {
  const id = (msgId ?? "").trim();
  if (!id || id === "?") return null;
  return `${target}\u0000${id}\u0000${rcpt.trim().toLowerCase()}`;
}

export function createDeliveryLedger(ttlMs: number, now: () => number = Date.now): DeliveryLedger {
  const entries = new Map<string, Entry>();

  const prune = () => {
    const t = now();
    for (const [k, e] of entries) {
      if (e.state !== "pending" && t - e.at > ttlMs) entries.delete(k);
    }
  };

  const wait = async (e: Entry, waitMs: number, joined: boolean): Promise<LedgerResult> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((resolve) => { timer = setTimeout(() => resolve("deadline"), waitMs); });
    try {
      const won = await Promise.race([e.promise.then(() => "done" as const, () => "done" as const), deadline]);
      if (won === "deadline") return { state: "pending", joined };
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (e.state === "delivered") return { state: "delivered", deduped: joined };
    return { state: "failed", error: e.error ?? "delivery failed" };
  };

  return {
    size: () => entries.size,
    async deliver(key, send, waitMs) {
      prune();
      if (key) {
        const seen = entries.get(key);
        if (seen?.state === "delivered") return { state: "delivered", deduped: true };
        if (seen?.state === "pending") return wait(seen, waitMs, true);
        if (seen?.state === "failed") entries.delete(key);
      }
      const entry: Entry = { state: "pending", at: now(), promise: Promise.resolve() };
      entry.promise = (async () => {
        try {
          await send();
          entry.state = "delivered";
        } catch (err) {
          entry.state = "failed";
          entry.error = (err as Error)?.message ?? String(err);
          throw err;
        } finally {
          entry.at = now();
          if (key && entry.state === "failed") entries.delete(key);
        }
      })();
      entry.promise.catch(() => {}); // never an unhandled rejection: the result is read from entry.state
      if (key) entries.set(key, entry);
      return wait(entry, waitMs, false);
    },
  };
}
