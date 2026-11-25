// #1926 GET /mail/stack: the whole mail stack as one structured answer for Cloud C3 Ops > Mail (Tables, Topology-Inbound,
// Topology-Outbound). The report is read from the private data repo with the same token /reports/status uses; the live
// probes (DNS, TLS expiry, MX reachability) are run here. Each source degrades on its own: the answer says which failed.
import { FastifyPluginAsync } from "fastify";
import { collectLive } from "../mailLive.js";
import { mailStack, parseReport, type Live, type Report } from "../mailStack.js";

const REPORT_URL = "https://raw.githubusercontent.com/diegonmarcos/cloud-data/main/y_old/reports/dist/cloud_mail_full.json";
const TTL_MS = 60_000;

let cache: { at: number; body: ReturnType<typeof mailStack> } | null = null;

async function readReport(): Promise<{ report: Report | null; error: string }> {
  const token = process.env.GITHUB_TOKEN;
  try {
    const res = await fetch(REPORT_URL, {
      headers: { "user-agent": "c3-infra-api", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { report: null, error: `report HTTP ${res.status}${token ? "" : " (no GITHUB_TOKEN)"}` };
    const report = parseReport(await res.text());
    return report ? { report, error: "" } : { report: null, error: "report is not a mail report" };
  } catch (e) {
    return { report: null, error: `report unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export const registerMailRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { fresh?: string } }>(
    "/mail/stack",
    { schema: { tags: ["mail"], summary: "Mail stack: probes by id, tables by section, fields not served" } },
    async (req) => {
      if (cache && Date.now() - cache.at < TTL_MS && req.query.fresh !== "1") return cache.body;
      const [r, live] = await Promise.all([
        readReport(),
        collectLive().then((l): { live: Live | null; error: string } => ({ live: l, error: "" }))
          .catch((e): { live: Live | null; error: string } => ({ live: null, error: e instanceof Error ? e.message : String(e) })),
      ]);
      const body = mailStack({ report: r.report, reportError: r.error, live: live.live, liveError: live.error });
      cache = { at: Date.now(), body };
      return body;
    },
  );
};
