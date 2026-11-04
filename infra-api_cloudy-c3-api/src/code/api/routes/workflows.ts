// ── Workflows Routes — generic GitHub Actions workflow_dispatch proxy ──
//
// Why this exists at all: the Android SuperApp wants a "run this workflow"
// button, and GitHub only accepts a repo-scoped PAT for
// `workflow_dispatch`. Shipping such a PAT inside an APK would publish it —
// APKs are trivially unzipped and every install would carry a token with
// write access to the fleet's CI. So the token stays HERE, server-side, and
// the app authenticates to THIS api with the credential it already has (an
// Authelia bearer, validated at the Caddy edge by plugins/auth.ts, which
// also admits mesh callers).
//
// Relationship to routes/reports.ts: that module already dispatches, but
// only the two health-report workflows, with the report kind as its input.
// It is deliberately left alone — it is the reports feature's own API. This
// module is the general case, and shares reports.ts's GITHUB_TOKEN env var
// rather than introducing a second secret.
//
// Scope control: dispatch targets are checked against an allowlist of repos
// below. A caller that can reach this route can therefore start CI in the
// fleet's own repositories and nothing else.

import { FastifyPluginAsync } from "fastify";

const GH_API = "https://api.github.com";

// Repos this proxy is willing to dispatch into. Anything else is a 400,
// so a compromised app token cannot reach arbitrary repositories the
// server-side PAT may happen to have access to.
export const DISPATCH_REPOS = [
  "diegonmarcos/cloudy-t-infra",
  "diegonmarcos/cloudy-u-containers",
  "diegonmarcos/cloudy-u-android",
  "diegonmarcos/front",
] as const;

// Workflow ids are file names ("ship.yml") or numeric ids. Anything with a
// path separator or a traversal segment is rejected before it is spliced
// into a GitHub URL.
const WORKFLOW_ID = /^[A-Za-z0-9._-]+$/;

function ghHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "c3-infra-api",
    authorization: `Bearer ${token}`,
  };
}

export const registerWorkflowsRoutes: FastifyPluginAsync = async (app) => {
  // ── What can be dispatched, and is dispatching even wired up? ──
  // The client calls this first so it can hide or disable its trigger
  // controls instead of offering a button that is guaranteed to 501.
  app.get(
    "/workflows/dispatch",
    {
      schema: {
        tags: ["reports"],
        summary: "Repos this API will dispatch workflows into",
      },
    },
    async () => ({
      repos: DISPATCH_REPOS,
      dispatchConfigured: Boolean(process.env.GITHUB_TOKEN),
    }),
  );

  // ── List a repo's workflows (so the UI can offer real choices) ──
  // "/workflows" itself belongs to observability.ts (the Dagu listing);
  // registering it here too made Fastify FST_ERR_DUPLICATED_ROUTE-crash the
  // whole API at boot (down 14:50-18:45 on 2026-09-06). This one lists GHA
  // workflows of an allowlisted repo, so it lives under /workflows/gha.
  app.get<{ Querystring: { repo?: string } }>(
    "/workflows/gha",
    {
      schema: {
        tags: ["reports"],
        summary: "List workflows of an allowlisted repo",
        querystring: {
          type: "object",
          properties: {
            repo: {
              type: "string",
              enum: DISPATCH_REPOS as unknown as string[],
              default: "diegonmarcos/cloudy-t-infra",
            },
          },
        },
      },
    },
    async (req, reply) => {
      const repo = req.query?.repo ?? "diegonmarcos/cloudy-t-infra";
      if (!(DISPATCH_REPOS as readonly string[]).includes(repo))
        return reply.code(400).send({ error: `repo not allowlisted: ${repo}` });

      const token = process.env.GITHUB_TOKEN;
      if (!token)
        return reply
          .code(501)
          .send({ error: "GITHUB_TOKEN not configured on c3-infra-api" });

      const res = await fetch(`${GH_API}/repos/${repo}/actions/workflows?per_page=100`, {
        headers: ghHeaders(token),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok)
        return reply.code(502).send({ error: `github: ${res.status}` });
      const body = (await res.json()) as any;
      return reply.send({
        repo,
        workflows: (body.workflows ?? [])
          // GitHub's workflow listing does not report which triggers a
          // workflow declares, so this cannot filter down to the
          // workflow_dispatch-capable ones. Disabled workflows are dropped
          // and the rest are offered; dispatching one that declares no
          // workflow_dispatch returns GitHub's own 422, which the dispatch
          // route below surfaces verbatim.
          .filter((w: any) => w.state === "active")
          .map((w: any) => ({
            id: w.id,
            name: w.name,
            path: w.path,
            fileName: String(w.path ?? "").split("/").pop(),
            state: w.state,
            url: w.html_url,
          })),
      });
    },
  );

  // ── Trigger a workflow_dispatch ──
  app.post<{
    Body: {
      repo?: string;
      workflow?: string;
      ref?: string;
      inputs?: Record<string, string>;
    };
  }>(
    "/workflows/dispatch",
    {
      schema: {
        tags: ["reports"],
        summary: "Dispatch a workflow_dispatch run in an allowlisted repo",
        body: {
          type: "object",
          required: ["workflow"],
          properties: {
            repo: {
              type: "string",
              enum: DISPATCH_REPOS as unknown as string[],
              default: "diegonmarcos/cloudy-t-infra",
            },
            workflow: { type: "string" },
            ref: { type: "string", default: "main" },
            inputs: { type: "object", additionalProperties: { type: "string" } },
          },
        },
      },
    },
    async (req, reply) => {
      const repo = req.body?.repo ?? "diegonmarcos/cloudy-t-infra";
      const workflow = req.body?.workflow ?? "";
      const ref = req.body?.ref ?? "main";
      const inputs = req.body?.inputs;

      if (!(DISPATCH_REPOS as readonly string[]).includes(repo))
        return reply.code(400).send({ error: `repo not allowlisted: ${repo}` });
      if (!WORKFLOW_ID.test(workflow))
        return reply.code(400).send({ error: `invalid workflow id: ${workflow}` });

      const token = process.env.GITHUB_TOKEN;
      if (!token)
        return reply.code(501).send({
          error: "GITHUB_TOKEN not configured on c3-infra-api",
          hint:
            "Add GITHUB_TOKEN (scope: actions:write) to this app's sops secrets.yaml. " +
            "Same variable routes/reports.ts already reads.",
        });

      const res = await fetch(
        `${GH_API}/repos/${repo}/actions/workflows/${workflow}/dispatches`,
        {
          method: "POST",
          headers: { ...ghHeaders(token), "content-type": "application/json" },
          body: JSON.stringify(inputs ? { ref, inputs } : { ref }),
          signal: AbortSignal.timeout(15000),
        },
      );

      // 204 No Content is the documented success for workflow dispatches.
      // Anything else — including a 200 — means GitHub did not queue a run,
      // so it is reported as a failure with GitHub's own message attached.
      if (res.status !== 204) {
        const detail = await res.text().catch(() => "");
        return reply.code(502).send({
          error: `dispatch failed: ${res.status}`,
          detail: detail.slice(0, 400),
        });
      }

      return reply.send({ ok: true, repo, workflow, ref });
    },
  );
};
