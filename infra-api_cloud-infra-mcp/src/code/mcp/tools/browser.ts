// ── browser.* — the headless browser for agents (#1498, #1540) ──
// One command API (ab_cloud-libs-shared/libs/headless-api/headless-api.json), three backends plus auto:
//   auto      DEFAULT: the container first; on a bot wall the same call goes to the cloudflare backend (browser-core.ts gateway)
//   cloudflare Cloudflare Browser Run REST API (account id + API token with Browser Run - Edit, by env NAME only)
//   phone     the phone's "This App" engine through Cloud-Webserver's mesh listener: POST <C3_PHONE_MESH_URL>/browser/command|run
//             (bearer = the fleet token, env C3_PHONE_FLEET_TOKEN; mesh peers only)
//   container cloudy-browser-headless on oci-apps behind Caddy: POST <C3_BROWSER_URL>/command|run (bearer env C3_BROWSER_TOKEN)
// Secrets are read from the environment by NAME only; nothing is hardcoded or logged.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { target, call, readUrl, gateway, defaultState, SUPPORT, OCR_TIMEOUT_MS } from "./browser-core.js";
import type { Backend, GwOp } from "./browser-core.js";
export { target, call, readUrl, gateway };
export type { Backend };
const SESSION_CMDS = ["open", "close", "wait", "eval", "click", "type", "scroll", "html", "text", "readable", "cookies", "storage", "network"] as const;

const BACKEND_DOC = "auto (DEFAULT) = container first, then Cloudflare Browser Run when a bot wall is detected (result carries backend_used and fallback_reason); container = cloudy-browser-headless; phone = the phone's engine over the mesh; cloudflare = Browser Run REST (no sessions)";
const common = {
  backend: z.enum(["auto", "container", "phone", "cloudflare"]).default("auto").describe(BACKEND_DOC),
  session: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional().describe("session id (open creates one when omitted; container/phone only)"),
  agent: z.string().max(64).optional().describe("agent name, shown in the audit log"),
  timeoutMs: z.number().int().min(1).max(120000).optional().describe("per-call timeout"),
};
const URL_PARAM = z.string().describe("http(s) URL");
const FORMAT_PARAMS: z.ZodRawShape = {
  format: z.enum(["markdown", "json", "xml"]).optional().describe("markdown (default, cheapest in tokens) | json (compact structured) | xml (minimal tags, slightly cheaper than json on fixtures)"),
  maxChars: z.number().int().min(500).max(200000).optional().describe("size cap of one page of output (default 20000)"),
  cursor: z.string().regex(/^\d{1,9}$/).optional().describe("the `next` value of a truncated result, to continue"),
};
const SHOT = {
  fullPage: z.boolean().optional().describe("full scrollable page instead of the viewport (phone: viewport only)"),
  format: z.enum(["png", "jpeg"]).optional().describe("image type (default png)"),
  quality: z.number().int().min(1).max(100).optional().describe("jpeg quality"),
};
const ELEMENTS = z.array(z.object({ selector: z.string().min(1), attrs: z.array(z.string()).optional().describe("attributes to return (all on cloudflare are filtered to these)") })).min(1).max(20);
const extra: Record<(typeof SESSION_CMDS)[number], z.ZodRawShape> = {
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
  cookies: { action: z.enum(["get", "set", "clear"]).default("get"), cookies: z.array(z.record(z.unknown())).optional() },
  storage: { area: z.enum(["local", "session"]), action: z.enum(["get", "set", "remove", "clear"]).default("get"), key: z.string().optional(), value: z.string().optional() },
  network: { action: z.enum(["log", "clear", "block", "unblock"]).default("log"), patterns: z.array(z.string()).optional() },
};

const asText = (o: unknown, isError = false) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }], isError });
const fail = (e: unknown) => asText({ ok: false, error: { code: "internal", message: e instanceof Error ? e.message : String(e) } }, true);

const DESC: Partial<Record<(typeof SESSION_CMDS)[number], string>> = {
  readable: "Headless browser: the CURRENT page as clean markdown (boilerplate, scripts, ads and tracking removed; frontmatter title/source/fetched_at; links and tables). Prefer browser.read for a URL. format markdown (default) | json | xml; json/xml are compact structured forms. Measured on 4 fixture pages (approximate tokenizer): markdown 1065 tokens, xml 1698 (+59%), json 1849 (+74%), so markdown is cheapest and xml is slightly cheaper than json. Long pages are capped: pass `next` back as cursor. Session backends only (container, phone).",
  html: "Headless browser: RAW HTML of the page or a selector of an open session. Explicit opt-in only: it is large and noisy. Prefer browser.read (markdown) unless the raw markup is the data; browser.content gives the rendered HTML of a URL.",
  text: "Headless browser: innerText of the page or a selector of an open session (unstructured). Prefer browser.read for page content.",
};

/** Session-only tools (the container or the phone keeps the page open between calls). */
async function sessionTool(cmd: string, args: any, f: typeof fetch) {
  const { backend, ...rest } = args;
  if (backend === "cloudflare") return asText({ ok: false, error: { code: "unsupported", message: `browser.${cmd} needs a session; the cloudflare backend is stateless (use container, phone or auto)` }, backend_used: "cloudflare", fallback_reason: null }, true);
  const b = backend === "phone" ? "phone" : "container";
  const r: any = await call(b, "command", { cmd, ...rest }, f);
  return asText(r?.ok === false ? r : { ...r, backend_used: b, fallback_reason: null }, r?.ok === false);
}

export function registerBrowserTools(server: McpServer, f: typeof fetch = fetch) {
  for (const cmd of SESSION_CMDS) {
    server.tool(`browser.${cmd}`, DESC[cmd] ?? `Headless browser session tool: ${cmd} (headless-api v1). Container and phone only.`, { ...common, ...extra[cmd] }, async (args: any) => {
      try { return await sessionTool(cmd, args, f); } catch (e) { return fail(e); }
    });
  }

  server.tool("browser.read", `Headless browser, DEFAULT tool: open a URL and return the page as clean markdown (no HTML, scripts, nav, ads or tracking params). Use this first. backend: ${BACKEND_DOC}. format markdown (default, cheapest) | xml | json (measured on fixtures: xml about 8% fewer tokens than json, markdown about 37% fewer than xml). Capped output: when truncated, call again with the returned session and \`next\` as cursor (container/phone) or with url and cursor (cloudflare). Use browser.content only when the raw markup is the data.`, {
    ...common, url: URL_PARAM, profile: z.string().optional(), ...FORMAT_PARAMS,
  }, async (args: any) => {
    try {
      if (args.cursor && args.session && args.backend !== "cloudflare") { const r = await readUrl({ ...args, backend: args.backend === "phone" ? "phone" : "container" }, f); return asText({ ...r, backend_used: args.backend === "phone" ? "phone" : "container", fallback_reason: null }, r?.ok === false); }
      const r = await gateway("read", args, { f });
      return asText(r, r?.ok === false);
    } catch (e) { return fail(e); }
  });

  const urlTool = (op: GwOp, desc: string, shape: z.ZodRawShape, sessionCmd: string) => {
    server.tool(`browser.${op}`, `${desc} Give url for a one-shot call (backend auto: container, falls back to Cloudflare Browser Run on a bot wall; result has backend_used and fallback_reason), or session to act on an open page (container/phone). Support: container yes, phone ${SUPPORT[op].phone ? "yes" : "NO"}, cloudflare yes.`, { ...common, url: URL_PARAM.optional(), profile: z.string().optional(), ...shape }, async (args: any) => {
      try {
        if (!args.url) {
          if (!args.session) return asText({ ok: false, error: { code: "bad_request", message: `browser.${op} needs url, or session of an open page` } }, true);
          const { url, profile, ...rest } = args;
          return await sessionTool(sessionCmd, rest, f);
        }
        const r = await gateway(op, args, { f });
        if (op === "screenshot" && r?.ok && r.base64) {
          const { base64, ...meta } = r;
          return { content: [{ type: "image" as const, data: base64, mimeType: r.mime ?? "image/png" }, { type: "text" as const, text: JSON.stringify(meta) }], isError: false };
        }
        return asText(r, r?.ok === false);
      } catch (e) { return fail(e); }
    });
  };
  urlTool("content", "Headless browser: the RENDERED HTML of a URL after scripts ran (Browser Run /content). Large; prefer browser.read unless the markup is the data.", {}, "content");
  urlTool("screenshot", "Headless browser: screenshot of a URL (full page or viewport, PNG or JPEG), returned as an image.", { ...SHOT, selector: z.string().optional().describe("capture one element (container/cloudflare)") }, "screenshot");
  urlTool("pdf", "Headless browser: the page as a PDF (base64 in `base64`, mime application/pdf).", { pdfFormat: z.string().optional().describe("A4 (default) | Letter | ..."), landscape: z.boolean().optional(), printBackground: z.boolean().optional() }, "pdf");
  urlTool("links", "Headless browser: all absolute http(s) links of a page (deduplicated).", { visibleOnly: z.boolean().optional().describe("only links visible on the page"), sameOrigin: z.boolean().optional().describe("only links to the same origin") }, "links");
  urlTool("scrape", "Headless browser: CSS selectors to text/html/attrs per matching element.", { elements: ELEMENTS, limit: z.number().int().min(1).max(1000).optional().describe("max items per selector (default 100)") }, "scrape");
  urlTool("snapshot", "Headless browser: rendered HTML and a screenshot of the same moment (Browser Run /snapshot).", SHOT, "snapshot");

  server.tool("browser.ocr", "Headless browser: render a page, find every <img> above a size threshold, download each and OCR it with ML OCR (Tesseract LSTM in the container, language data bundled), returning [{kind, src, alt, width, height, ocr_text, confidence 0-100, engine, low_confidence?, error?}] plus the concatenated `text`. One bad image only gets its own `error`. includeScreenshot also OCRs the rendered page (text baked into canvas/WebGL, CSS or video posters); the screenshot is an entry with kind screenshot. engine tesseract (default) | paddle (opt-in, needs the PaddleOCR sidecar PADDLE_OCR_URL; otherwise a per-image unsupported error). escalateBelow N (default off) retries images with confidence < N on paddle. Give url for a one-shot call or session for an open page. Container only (the phone and Cloudflare have no OCR); CPU work, a few seconds per image, so keep maxImages small and raise timeoutMs for many images.", {
    ...common,
    url: URL_PARAM.optional(), profile: z.string().optional(),
    engine: z.enum(["tesseract", "paddle"]).default("tesseract").describe("OCR engine (default tesseract; paddle is opt-in)"),
    minWidth: z.number().int().min(1).max(10000).default(150).describe("skip images narrower than this (natural px, default 150)"),
    minHeight: z.number().int().min(1).max(10000).default(150).describe("skip images shorter than this (natural px, default 150)"),
    includeScreenshot: z.boolean().default(false).describe("also OCR the rendered page screenshot (catches text drawn on canvas/WebGL)"),
    fullPage: z.boolean().optional().describe("screenshot the full page (default true, cropped to 6000 px) instead of the viewport"),
    lang: z.string().regex(/^[a-z]{3}(\+[a-z]{3}){0,2}$/).default("eng").describe("tesseract language: eng fra deu spa ita por, join up to 3 with + (default eng)"),
    maxImages: z.number().int().min(1).max(50).default(12).describe("cap on OCR'd images (document order; the rest is reported as truncated)"),
    escalateBelow: z.number().min(0).max(100).optional().describe("re-run images with confidence below this on paddle when configured (default off, 0)"),
  }, async (args: any) => {
    try {
      if (!args.url) {
        if (!args.session) return asText({ ok: false, error: { code: "bad_request", message: "browser.ocr needs url, or session of an open page" } }, true);
        const { url, profile, ...rest } = args;
        return await sessionTool("ocr", { timeoutMs: OCR_TIMEOUT_MS, ...rest }, f);
      }
      const r = await gateway("ocr", args, { f });
      return asText(r, r?.ok === false);
    } catch (e) { return fail(e); }
  });

  server.tool("browser.json", "Headless browser: structured extraction. Give url, a prompt and/or a JSON schema; returns {data}. cloudflare backend uses Browser Run /json (Workers AI, billed); container/phone fetch the page as markdown and ask our own model through OpenRouter (key OPENROUTER_API_KEY from the private store, model C3_BROWSER_JSON_MODEL); auto = container path, Cloudflare on a bot wall. With a schema the result is checked and schema_errors lists mismatches.", {
    ...common, url: URL_PARAM, profile: z.string().optional(), prompt: z.string().max(4000).optional(), schema: z.record(z.unknown()).optional().describe("JSON schema of the wanted output"),
  }, async (args: any) => {
    try {
      if (!args.prompt && !args.schema) return asText({ ok: false, error: { code: "bad_request", message: "browser.json needs a prompt and/or a schema" } }, true);
      const r = await gateway("json", args, { f });
      return asText(r, r?.ok === false);
    } catch (e) { return fail(e); }
  });

  server.tool("browser.usage", "Headless browser gateway: today's Cloudflare Browser Run calls and estimated cost (browser hours at the paid rate, an upper bound), the daily caps, and the per-domain 'needs cloudflare' memory (24 h TTL).", {}, async () => asText({ ok: true, ...defaultState().usage() }));

  server.tool("browser.run", "Headless browser: run a list of steps in one session, each with its own timeout (headless-api v1 run). Container and phone only.", {
    backend: z.enum(["auto", "container", "phone"]).default("auto").describe("auto = container"),
    session: common.session,
    stepTimeoutMs: z.number().int().min(1).max(120000).optional(),
    stopOnError: z.boolean().optional(),
    steps: z.array(z.record(z.unknown())).min(1).max(50).describe("commands: {cmd, ...params} as in browser.<cmd>"),
  }, async ({ backend, ...body }: any) => {
    try {
      const b = backend === "phone" ? "phone" : "container";
      const r: any = await call(b, "run", body, f);
      return asText(r?.ok === false ? r : { ...r, backend_used: b, fallback_reason: null }, r?.ok === false);
    } catch (e) { return fail(e); }
  });
}
