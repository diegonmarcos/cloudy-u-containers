// Run: node --test gateway.test.ts   (Node >= 22.18, no dependencies)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { DEFAULT_BACKENDS, loadBackends, matchRoute, forwardHeaders } from "./gateway.ts";

test("the five /ai routes resolve to their own backend and keep path and query", () => {
  for (const n of ["tokens", "embeddings", "agents", "claude", "memory"]) {
    const m = matchRoute(DEFAULT_BACKENDS, `/ai/${n}/v1/x?a=1&b=2`);
    assert.equal(m?.backend.name, n);
    assert.ok(m!.target.endsWith("/v1/x?a=1&b=2"), m!.target);
    assert.equal(m!.legacy, false);
  }
});
test("backends are separate: no two routes share a url", () => {
  assert.equal(new Set(DEFAULT_BACKENDS.map((b) => b.url)).size, 5);
});
test("bare /ai/<name> maps to the backend root", () => {
  assert.equal(matchRoute(DEFAULT_BACKENDS, "/ai/tokens")?.target, "http://127.0.0.1:4184/");
});
test("legacy old-name paths still resolve (alias release) and are flagged", () => {
  for (const [old, n] of [["tokens-api", "tokens"], ["embeddings-api", "embeddings"], ["my-ai-api", "agents"], ["claude-superset-api", "claude"], ["session-memory", "memory"]]) {
    const m = matchRoute(DEFAULT_BACKENDS, `/${old}/health`);
    assert.equal(m?.backend.name, n);
    assert.equal(m!.legacy, true);
  }
});
test("unknown routes, empty path and traversal are rejected", () => {
  for (const p of ["/", "/ai", "/ai/", "/ai/nope/x", "/nope", "/ai/tokens/../embeddings", "/ai//tokens", "/ai/tokens\\x"]) assert.equal(matchRoute(DEFAULT_BACKENDS, p), null, p);
  assert.equal(matchRoute(DEFAULT_BACKENDS, "/ai/tokens-api/x"), null, "a legacy name is not valid under /ai");
});
test("ROUTES override is validated", () => {
  assert.equal(loadBackends({}), DEFAULT_BACKENDS);
  assert.equal(loadBackends({ ROUTES: '[{"name":"x","url":"http://h:1"}]' })[0].legacy.length, 0);
  assert.throws(() => loadBackends({ ROUTES: '[{"name":"Bad Name","url":"u"}]' }), /ROUTES/);
});
test("hop-by-hop headers are dropped, Authorization is kept", () => {
  const h = forwardHeaders({ host: "x", connection: "close", authorization: "Bearer t", "content-type": "a/b", "transfer-encoding": "chunked" });
  assert.deepEqual(Object.keys(h).sort(), ["authorization", "content-type"]);
});

test("end to end: gateway index.ts proxies to a real backend and sends the right path/headers", async () => {
  const seen: any[] = [];
  const backend: Server = createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c));
    req.on("end", () => { seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body }); res.writeHead(201, { "x-from": "backend" }); res.end("ok"); });
  });
  await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
  const bport = (backend.address() as any).port;
  const { spawn } = await import("node:child_process");
  const gport = 40000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [new URL("./index.ts", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(gport), BIND_HOST: "127.0.0.1", ROUTES: JSON.stringify([{ name: "tokens", url: `http://127.0.0.1:${bport}`, legacy: ["tokens-api"] }]) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => { child.stderr!.on("data", (d) => String(d).includes("routes=") && resolve()); child.on("exit", () => reject(new Error("gateway exited"))); });
    const call = (path: string, method = "GET", body?: string) => new Promise<{ status: number; headers: any; text: string }>((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port: gport, path, method, headers: { authorization: "Bearer t0k" } }, (res) => { let t = ""; res.on("data", (c) => (t += c)); res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, text: t })); });
      r.on("error", reject); if (body) r.write(body); r.end();
    });
    const a = await call("/ai/tokens/v1/t?x=1", "POST", '{"a":1}');
    assert.equal(a.status, 201); assert.equal(a.headers["x-from"], "backend"); assert.equal(a.headers["deprecation"], undefined);
    assert.deepEqual(seen[0], { url: "/v1/t?x=1", method: "POST", auth: "Bearer t0k", body: '{"a":1}' });
    const b = await call("/tokens-api/v1/t");
    assert.match(b.headers["deprecation"], /\/ai\/tokens/); assert.equal(seen[1].url, "/v1/t");
    assert.equal((await call("/ai/nope")).status, 404);
    assert.equal((await call("/health")).status, 200);
  } finally { child.kill(); backend.close(); }
});
