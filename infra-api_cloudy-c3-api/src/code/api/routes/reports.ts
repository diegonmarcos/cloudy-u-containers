// ── Reports Routes — health-check report orchestration ──
// The report generators live in GitHub Actions, NOT in this API, on purpose:
// this API runs on oci-apps and may itself be down, so report *triggering* and
// report *data* must not depend on it being healthy.
//
// Two interchangeable runners, same `report` input, same published artifacts:
//   gha      -> cloud-health-reports-x86-gha.yml      (ubuntu-latest, default)
//   oci-apps -> cloud-health-reports-arm-oci-apps.yml (self-hosted arm64)
//
// Artifacts are published to diegonmarcos/cloud-data, which is PRIVATE — it
// also holds the Claude session archives, so it is not a candidate for being
// made public. This header used to say PUBLIC and concluded that browsers
// could fetch report DATA straight from raw.githubusercontent; they cannot,
// and that false premise is why the freshness probe below silently 404'd.
// This module orchestrates runs and reports their status; anything serving
// report BODIES to a browser has to proxy them through here with the token.

import { FastifyPluginAsync } from "fastify";

const GH_API = "https://api.github.com";
const OWNER_REPO = "diegonmarcos/cloudy-t-infra";
const DATA_REPO = "diegonmarcos/cloud-data";
// `y_old/` is not a typo and not an archive. All three cloud-health-reports
// workflows publish here, so it IS the live path — the name is historical and
// renaming it would break every URL already handed out. This pointed at
// `reports/dist`, which holds only the GHA traces, so every freshness lookup
// 404'd and /reports/status reported the whole fleet as never having run.
const DATA_PATH = "y_old/reports/dist";
const RAW_BASE = `https://raw.githubusercontent.com/${DATA_REPO}/main/${DATA_PATH}`;

// Runner -> workflow file. Keys are the only accepted `runner` values.
export const REPORT_RUNNERS: Record<string, string> = {
  gha: "cloud-health-reports-x86-gha.yml",
  "oci-apps": "cloud-health-reports-arm-oci-apps.yml",
};

// Mirrors the workflow_dispatch `report` input options. Anything else is rejected
// before it reaches GitHub.
//
// These must match entrypoint.sh's case statement exactly. Its final arm is
// `*) exec "$@"`, so a kind the engine does not know is not rejected — it is
// RUN AS A SHELL COMMAND and the job dies with `exec: <kind>: not found`
// (exit 127), which reads like a broken image rather than a bad input. The
// list used to advertise "cloud", which the engine has never accepted, and to
// omit "daily", which it has always accepted.
export const REPORT_KINDS = [
  "all",
  "daily",
  "daily-mail",
  "mail",
  "url",
  "sec-network",
  "sec-data",
] as const;

// Published artifact families (json + md per family).
export const REPORT_FAMILIES = [
  "cloud_health_daily",
  "cloud_mail_full",
  "cloud_sec_data",
  "cloud_sec_network",
] as const;

function ghHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "c3-infra-api",
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

export const registerReportsRoutes: FastifyPluginAsync = async (app) => {
  // ── List runners + report kinds (lets the UI build controls without hardcoding) ──
  app.get(
    "/reports/runners",
    {
      schema: {
        tags: ["reports"],
        summary: "Available report runners and report kinds",
      },
    },
    async () => ({
      runners: Object.keys(REPORT_RUNNERS),
      defaultRunner: "gha",
      kinds: REPORT_KINDS,
      families: REPORT_FAMILIES,
      // Told to the client so it can fetch data directly and stay working
      // even when this API is unreachable.
      dataBase: RAW_BASE,
      dispatchConfigured: Boolean(process.env.GITHUB_TOKEN),
    }),
  );

  // ── Freshness of each published family (HEAD only — no payload proxying) ──
  app.get(
    "/reports/status",
    { schema: { tags: ["reports"], summary: "Published report freshness" } },
    async () => {
      // Freshness comes from the commits API, not a HEAD on raw, for two
      // reasons that each break the HEAD on their own:
      //
      //   1. cloud-data is PRIVATE. Unauthenticated raw.githubusercontent
      //      answers 404 for it, and the catch below turned that into a
      //      plausible-looking "ok: false" row rather than anything that read
      //      as misconfiguration. Every family looked equally dead, which is
      //      also what a genuinely halted fleet looks like.
      //   2. raw serves private content with NO last-modified header (etag
      //      only), so even authenticated the age arithmetic yields NaN.
      //
      // The commits API needs the same token the dispatch path already uses,
      // returns a real date, and is per-path — which matters because the
      // failure worth catching is one family going stale while the rest keep
      // publishing, not the whole set stopping at once.
      const token = process.env.GITHUB_TOKEN;
      const out = await Promise.all(
        REPORT_FAMILIES.map(async (fam) => {
          const url = `${RAW_BASE}/${fam}.json`;
          const links = { json: url, markdown: `${RAW_BASE}/${fam}.md` };
          try {
            const res = await fetch(
              `${GH_API}/repos/${DATA_REPO}/commits` +
                `?path=${encodeURIComponent(`${DATA_PATH}/${fam}.json`)}&per_page=1`,
              { headers: ghHeaders(token), signal: AbortSignal.timeout(8000) },
            );
            if (!res.ok) {
              return { family: fam, ok: false, status: res.status, ...links };
            }
            const commits = (await res.json()) as any[];
            const lm = commits[0]?.commit?.committer?.date ?? null;
            const ageH = lm
              ? Math.round((Date.now() - new Date(lm).getTime()) / 36e5)
              : null;
            return {
              family: fam,
              // No commit touching this path means the family has NEVER
              // published. That is not a healthy zero, so it is not ok.
              ok: lm !== null,
              status: res.status,
              lastModified: lm,
              ageHours: ageH,
              stale: ageH === null ? null : ageH > 48,
              ...links,
            };
          } catch (e) {
            return {
              family: fam,
              ok: false,
              error: e instanceof Error ? e.message : String(e),
              ...links,
            };
          }
        }),
      );
      // `base` is a raw URL into a private repo: a browser cannot fetch it
      // without a token. Callers that render report BODIES need a proxied
      // route here; the module header still claims the repo is public.
      return { families: out, base: RAW_BASE, baseRequiresAuth: true };
    },
  );

  // ── Recent runs for both workflows ──
  app.get(
    "/reports/runs",
    { schema: { tags: ["reports"], summary: "Recent report workflow runs" } },
    async (_req, reply) => {
      const token = process.env.GITHUB_TOKEN;
      const runs: unknown[] = [];
      for (const [runner, wf] of Object.entries(REPORT_RUNNERS)) {
        try {
          const res = await fetch(
            `${GH_API}/repos/${OWNER_REPO}/actions/workflows/${wf}/runs?per_page=10`,
            { headers: ghHeaders(token), signal: AbortSignal.timeout(10000) },
          );
          if (!res.ok) continue;
          const body = (await res.json()) as any;
          for (const r of body.workflow_runs ?? []) {
            runs.push({
              runner,
              id: r.id,
              status: r.status,
              conclusion: r.conclusion,
              createdAt: r.created_at,
              updatedAt: r.updated_at,
              event: r.event,
              url: r.html_url,
            });
          }
        } catch {
          // A single workflow being unreachable must not fail the whole listing.
        }
      }
      runs.sort((a: any, b: any) => (a.createdAt < b.createdAt ? 1 : -1));
      return reply.send({ runs });
    },
  );

  // ── Single run status (for polling after a dispatch) ──
  app.get<{ Params: { id: string } }>(
    "/reports/runs/:id",
    {
      schema: {
        tags: ["reports"],
        summary: "Status of one report run",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", pattern: "^[0-9]+$" } },
        },
      },
    },
    async (req, reply) => {
      const res = await fetch(
        `${GH_API}/repos/${OWNER_REPO}/actions/runs/${req.params.id}`,
        {
          headers: ghHeaders(process.env.GITHUB_TOKEN),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!res.ok)
        return reply.code(res.status).send({ error: `github: ${res.status}` });
      const r = (await res.json()) as any;
      return reply.send({
        id: r.id,
        status: r.status,
        conclusion: r.conclusion,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        url: r.html_url,
      });
    },
  );

  // ── Trigger a report run ──
  app.post<{ Body: { report?: string; runner?: string } }>(
    "/reports/run",
    {
      schema: {
        tags: ["reports"],
        summary: "Dispatch a report workflow (default runner: gha)",
        body: {
          type: "object",
          properties: {
            report: { type: "string", enum: REPORT_KINDS as unknown as string[] },
            runner: {
              type: "string",
              enum: Object.keys(REPORT_RUNNERS),
              default: "gha",
            },
          },
        },
      },
    },
    async (req, reply) => {
      const report = req.body?.report ?? "all";
      const runner = req.body?.runner ?? "gha";

      // Validate against allowlists before anything leaves this process.
      if (!REPORT_KINDS.includes(report as (typeof REPORT_KINDS)[number]))
        return reply.code(400).send({ error: `unknown report: ${report}` });
      const workflow = REPORT_RUNNERS[runner];
      if (!workflow)
        return reply.code(400).send({ error: `unknown runner: ${runner}` });

      const token = process.env.GITHUB_TOKEN;
      if (!token)
        return reply.code(501).send({
          error: "GITHUB_TOKEN not configured on c3-infra-api",
          hint:
            "Add GITHUB_TOKEN (scope: actions:write) to this app's sops secrets.yaml, " +
            "or dispatch from the browser with a user-supplied PAT.",
        });

      const res = await fetch(
        `${GH_API}/repos/${OWNER_REPO}/actions/workflows/${workflow}/dispatches`,
        {
          method: "POST",
          headers: { ...ghHeaders(token), "content-type": "application/json" },
          body: JSON.stringify({ ref: "main", inputs: { report } }),
          signal: AbortSignal.timeout(15000),
        },
      );

      // 204 No Content is the documented success for workflow dispatches.
      if (res.status !== 204) {
        const detail = await res.text().catch(() => "");
        return reply
          .code(502)
          .send({ error: `dispatch failed: ${res.status}`, detail: detail.slice(0, 400) });
      }

      return reply.send({ ok: true, report, runner, workflow });
    },
  );
};
