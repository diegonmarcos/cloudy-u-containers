/**
 * Jev advisory for a failed GHA run (#883 S12): is this a FLAKE (runner hiccup, network, registry, a cancelled
 * dependency) or a REAL failure (a test or build that fails again)? It only ADVISES: the report gains one line, and
 * nothing is rerun, cancelled or changed by it (the audited gha_rerun_job tool stays a human/agent decision). The
 * sidecar answers "no opinion" for every failure and for the use's evidence gate while it is closed, and then the
 * report is byte-for-byte what it was. Zero imports so a test can load it without the runtime.
 */

export interface JevFlakeAnswer {
  line: string; // "" = no opinion
  call: string | null;
}

const NONE: JevFlakeAnswer = { line: "", call: null };

export async function jevFlake(
  workflow: string,
  logTail: string[],
  fetchImpl: typeof fetch = fetch,
  env: Record<string, string | undefined> = process.env,
): Promise<JevFlakeAnswer> {
  try {
    if (env.JEV_GHA === "0" || logTail.length === 0) return NONE;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Number(env.JEV_TIMEOUT_MS ?? 2500));
    try {
      const res = await fetchImpl(`${env.JEV_SIDECAR_URL ?? "http://10.0.0.6:3110"}/decide/gha_flake_vs_real`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctl.signal,
        body: JSON.stringify({
          state: { workflow, failed_step_tail: logTail.slice(-15).join("\n").slice(0, 3000) },
          questions: {
            flake: {
              type: "noul",
              instructions:
                "The CI failure whose last log lines are in `failed_step_tail` (workflow `workflow`) is a transient flake " +
                "(runner, network, registry, cache or cancellation) that a plain rerun would very likely fix, not a real defect in the change.",
            },
          },
        }),
      });
      if (!res.ok) return NONE;
      const ans: any = await res.json();
      const call = typeof ans?.call === "string" ? ans.call : null;
      const r = ans?.ok === true ? ans.results?.flake : null;
      if (!r || r.confident !== true || typeof r.value !== "boolean") return { line: "", call };
      return {
        line: `  Jev suggests: ${r.value ? "likely a FLAKE (a rerun would probably pass)" : "likely a REAL failure"} (p=${Number(r.p).toFixed(2)})`,
        call,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return NONE;
  }
}
