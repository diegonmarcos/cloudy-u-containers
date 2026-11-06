// ── browser.* — the headless browser for agents (#1498) ──
// One command API (ab_cloud-libs-shared/libs/headless-api/headless-api.json), two backends:
//   phone     the phone's "This App" engine through Cloud-Webserver's mesh listener: POST <C3_PHONE_MESH_URL>/browser/command|run
//             (bearer = the fleet token, env C3_PHONE_FLEET_TOKEN; mesh peers only)
//   container cloudy-browser-headless on oci-apps behind Caddy: POST <C3_BROWSER_URL>/command|run (bearer env C3_BROWSER_TOKEN)
// Secrets are read from the environment by NAME only; nothing is hardcoded or logged.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { target, call, readUrl } from "./browser-core.js";
import type { Backend } from "./browser-core.js";
export { target, call, readUrl };
export type { Backend };
const CMDS = ["open", "close", "wait", "eval", "click", "type", "scroll", "html", "text", "readable", "screenshot", "cookies", "storage", "network"] as const;

const common = {
  backend: z.enum(["phone", "container"]).default("container").describe("phone = the phone's engine over the mesh /browser; container = cloudy-browser-headless"),
  session: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().describe("session id (open creates one when omitted)"),
  agent: z.string().max(64).optional().describe("agent name, shown in the audit log"),
  timeoutMs: z.number().int().min(1).max(120000).optional().describe("per-call timeout"),
};
const FORMAT_PARAMS: z.ZodRawShape = {
  format: z.enum(["markdown", "json", "xml"]).optional().describe("markdown (default, cheapest in tokens) | json (compact structured) | xml (minimal tags, slightly cheaper than json on fixtures)"),
  maxChars: z.number().int().min(500).max(200000).optional().describe("size cap of one page of output (default 20000)"),
  cursor: z.string().regex(/^\d{1,9}$/).optional().describe("the `next` value of a truncated result, to continue"),
};
const extra: Record<(typeof CMDS)[number], z.ZodRawShape> = {
  open: { url: z.string().describe("http(s) URL"), profile: z.string().optional() },
  close: {},
  wait: { selector: z.string().optional(), idle: z.boolean().optional(), ms: z.number().int().min(0).optional() },
  eval: { js: z.string() },
  click: { selector: z.string() },
  type: { selector: z.string(), text: z.string(), clear: z.boolean().optional() },
  scroll: { selector: z.string().optional(), x: z.number().int().optional(), y: z.number().int().optional() },
  html: { selector: z.string().optional() },
  text: { selector: z.string().optional() },
  readable: FORMAT_PARAMS,
  screenshot: { fullPage: z.boolean().optional(), selector: z.string().optional() },
  cookies: { action: z.enum(["get", "set", "clear"]).default("get"), cookies: z.array(z.record(z.unknown())).optional() },
  storage: { area: z.enum(["local", "session"]), action: z.enum(["get", "set", "remove", "clear"]).default("get"), key: z.string().optional(), value: z.string().optional() },
  network: { action: z.enum(["log", "clear", "block", "unblock"]).default("log"), patterns: z.array(z.string()).optional() },
};

const asText = (o: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }], isError });

const DESC: Partial<Record<(typeof CMDS)[number], string>> = {
  readable: "Headless browser: the CURRENT page as clean markdown (boilerplate, scripts, ads and tracking removed; frontmatter title/source/fetched_at; links and tables). Prefer browser.read for a URL. format markdown (default) | json | xml; json/xml are compact structured forms. Measured on 4 fixture pages (approximate tokenizer): markdown 1065 tokens, xml 1698 (+59%), json 1849 (+74%), so markdown is cheapest and xml is slightly cheaper than json. Long pages are capped: pass `next` back as cursor.",
  html: "Headless browser: RAW HTML of the page or a selector. Explicit opt-in only: it is large and noisy. Prefer browser.read (markdown) unless the raw markup itself is the data.",
  text: "Headless browser: innerText of the page or a selector (unstructured). Prefer browser.read for page content.",
};

export function registerBrowserTools(server: McpServer, f: typeof fetch = fetch) {
  for (const cmd of CMDS) {
    server.tool(`browser.${cmd}`, DESC[cmd] ?? `Headless browser: ${cmd} (headless-api v1).`, { ...common, ...extra[cmd] }, async (args: any) => {
      const { backend, ...rest } = args;
      try {
        const r: any = await call(backend, "command", { cmd, ...rest }, f);
        return asText(r, r?.ok === false);
      } catch (e) { return asText({ ok: false, error: { code: "internal", message: e instanceof Error ? e.message : String(e) } }, true); }
    });
  }
  server.tool("browser.read", "Headless browser, DEFAULT tool: open a URL and return the page as clean markdown (open + readable in one call; no HTML, scripts, nav, ads or tracking params). Use this first. format markdown (default, cheapest) | xml | json (compact structured alternatives; measured on fixtures: xml about 8% fewer tokens than json, markdown about 37% fewer than xml). Capped output: when truncated, call again with the returned session and `next` as cursor. Use browser.html only when the raw markup is the data.", {
    ...common, url: z.string().describe("http(s) URL"), profile: z.string().optional(), ...FORMAT_PARAMS,
  }, async (args: any) => {
    try {
      const r = await readUrl(args, f);
      return asText(r, r?.ok === false);
    } catch (e) { return asText({ ok: false, error: { code: "internal", message: e instanceof Error ? e.message : String(e) } }, true); }
  });
  server.tool("browser.run", "Headless browser: run a list of steps in one session, each with its own timeout (headless-api v1 run).", {
    backend: common.backend,
    session: common.session,
    stepTimeoutMs: z.number().int().min(1).max(120000).optional(),
    stopOnError: z.boolean().optional(),
    steps: z.array(z.record(z.unknown())).min(1).max(50).describe("commands: {cmd, ...params} as in browser.<cmd>"),
  }, async ({ backend, ...body }: any) => {
    try {
      const r: any = await call(backend, "run", body, f);
      return asText(r, r?.ok === false);
    } catch (e) { return asText({ ok: false, error: { code: "internal", message: e instanceof Error ? e.message : String(e) } }, true); }
  });
}
