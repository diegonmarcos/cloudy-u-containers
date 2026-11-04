// Streaming reverse proxy for cloudy-ai-api. Auth stays with the backends
// (tokens-api scoped tokens) and Caddy (bearer on the public /ai route).
import { createServer, request as httpRequest } from "node:http";
import { loadBackends, matchRoute, forwardHeaders } from "./gateway.ts";

const backends = loadBackends();
const port = parseInt(process.env.PORT || process.env.MCP_HTTP_PORT || "4185", 10);
const host = process.env.BIND_HOST || "0.0.0.0";

createServer((req, res) => {
  const url = req.url ?? "/";
  if (url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, routes: backends.map((b) => b.name) })); return; }
  const m = matchRoute(backends, url);
  if (!m) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "no such route", routes: backends.map((b) => `/ai/${b.name}`) })); return; }
  const t = new URL(m.target);
  const up = httpRequest({ hostname: t.hostname, port: t.port, path: t.pathname + t.search, method: req.method, headers: forwardHeaders(req.headers) }, (r) => {
    const headers = { ...r.headers };
    if (m.legacy) headers["deprecation"] = `use /ai/${m.backend.name}`;
    res.writeHead(r.statusCode ?? 502, headers);
    r.pipe(res);
  });
  up.on("error", (e) => { if (!res.headersSent) { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: `backend ${m.backend.name}: ${e.message}` })); } else res.destroy(); });
  req.pipe(up);
}).listen(port, host, () => process.stderr.write(`[cloudy-ai-api] :${port} routes=${backends.map((b) => b.name).join(",")}\n`));
