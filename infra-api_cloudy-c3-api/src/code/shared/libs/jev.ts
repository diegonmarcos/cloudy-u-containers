/**
 * Jev advisory client (#882 S3): ask the jev-sidecar (WireGuard mesh, `jev-gate serve`) how urgent an
 * alert is. Jev only RE-RANKS: the caller's hard-coded priority is the fallback and is used on ANY
 * failure -- no sidecar, no key (OPENROUTER_API_KEY unset), timeout, HTTP error, malformed answer,
 * observe-only / gate closed, not confident, a priority the caller did not offer. Never throws, never
 * waits longer than JEV_TIMEOUT_MS, and never ranks below "default" (an alert is never silenced by Jev).
 * Zero imports so a test can load it without the runtime.
 */

export type JevPriority = "default" | "high" | "urgent";
const OPTIONS: JevPriority[] = ["default", "high", "urgent"];

export interface JevAlertState {
  rule: string;
  target: string;
  metric: string;
  op: string;
  threshold: number;
  value: number;
}

export interface JevAlertAnswer {
  priority: JevPriority | null; // null = no opinion: the caller keeps its hard-coded priority
  call: string | null; // the sidecar's id of this decision, even when held (observe-only): the outcome joins on it
}
const NONE: JevAlertAnswer = { priority: null, call: null };

export async function jevAlertPriority(
  state: JevAlertState,
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<JevAlertAnswer> {
  try {
    if (env.JEV_ALERTS === "0") return NONE;
    const base = env.JEV_SIDECAR_URL ?? "http://10.0.0.6:3110";
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Number(env.JEV_TIMEOUT_MS ?? 2500));
    try {
      const res = await fetchImpl(`${base}/decide/alert_priority`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctl.signal,
        body: JSON.stringify({
          state,
          questions: {
            priority: {
              type: "choice",
              instructions:
                "How urgently should a human be interrupted for this fleet alert (rule, target, metric, value against its threshold)?",
              criteria: {
                default: "Worth knowing, but can wait for the next time the person looks at their phone.",
                high: "Needs attention soon; the normal alert level.",
                urgent: "Needs attention immediately: something is failing or about to.",
              },
            },
          },
        }),
      });
      if (!res.ok) return NONE;
      const ans: any = await res.json();
      const call = typeof ans?.call === "string" ? ans.call : null;
      const r = ans?.ok === true ? ans.results?.priority : null;
      if (!r || r.confident !== true || !OPTIONS.includes(r.pick)) return { priority: null, call };
      return { priority: r.pick as JevPriority, call };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return NONE;
  }
}

/**
 * The OUTCOME of an alert, from what was observed: how long it stayed open. Resolved within 10 min = it
 * could wait ("default"); within 2 h = the normal level ("high"); longer = it needed a human ("urgent").
 * Posted to the sidecar's /outcome so the use's precision (and the gates that wait on it) can be measured
 * without a manual label. Never throws.
 */
export function jevAlertLabel(openMs: number): JevPriority {
  return openMs < 10 * 60_000 ? "default" : openMs < 2 * 3_600_000 ? "high" : "urgent";
}

export async function jevAlertOutcome(
  call: string | null,
  openMs: number,
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  try {
    if (!call || env.JEV_ALERTS === "0") return;
    await fetchImpl(`${env.JEV_SIDECAR_URL ?? "http://10.0.0.6:3110"}/outcome/alert_priority`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(Number(env.JEV_TIMEOUT_MS ?? 2500)),
      body: JSON.stringify({ call, label: { priority: jevAlertLabel(openMs) } }),
    });
  } catch {
    /* an outcome is best effort */
  }
}
