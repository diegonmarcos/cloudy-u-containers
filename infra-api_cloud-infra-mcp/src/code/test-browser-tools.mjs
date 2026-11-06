// browser.* (#1498): backend routing, secrets by env name, request shape. Run: node --experimental-strip-types test-browser-tools.mjs
import assert from "node:assert/strict";
import { target, call, readUrl, detectBotWall, gateway, cfConf, cfRequestFor, cfNormalize, BrowserState, configFromEnv, validateAgainstSchema, extractJsonViaOpenRouter, SUPPORT, GW_OPS, PROBE_JS } from "./mcp/tools/browser-core.ts";

const env = { C3_PHONE_MESH_URL: "http://10.0.0.9:8004/", C3_PHONE_FLEET_TOKEN: "ft", C3_BROWSER_URL: "https://mcp.example/cloudy-browser-headless/", C3_BROWSER_TOKEN: "bt" };
assert.deepEqual(target("phone", "command", env), { url: "http://10.0.0.9:8004/browser/command", bearer: "ft" });
assert.deepEqual(target("container", "run", env), { url: "https://mcp.example/cloudy-browser-headless/run", bearer: "bt" });
assert.throws(() => target("phone", "command", {}), /phone backend not configured/);
assert.throws(() => target("container", "command", { C3_BROWSER_URL: "https://x" }), /container backend not configured/);
assert.deepEqual(target("container", "command", { C3_BROWSER_TOKEN: "t" }), { url: "http://10.0.0.6:3118/command", bearer: "t" });

const seen = [];
const fake = async (url, init) => { seen.push([url, init.headers.authorization, JSON.parse(init.body)]); return new Response(JSON.stringify({ ok: true, session: "s1" })); };
const r = await call("container", "command", { cmd: "open", url: "https://a.test" }, fake, env);
assert.equal(r.ok, true);
assert.deepEqual(seen[0], ["https://mcp.example/cloudy-browser-headless/command", "Bearer bt", { cmd: "open", url: "https://a.test" }]);
const bad = await call("phone", "run", { steps: [] }, async () => new Response("<html>", { status: 502 }), env);
assert.equal(bad.ok, false);
assert.equal(bad.error.message, "HTTP 502");

// browser.read = open + readable in ONE run call; returns the page content only (no HTML), with the continuation cursor
const runs = [];
const rf = async (url, init) => { runs.push([url, JSON.parse(init.body)]); return new Response(JSON.stringify({ ok: true, session: "s9", steps: [{ ok: true, session: "s9", result: { url: "https://a.test/" } }, { ok: true, session: "s9", result: { format: "markdown", title: "A", url: "https://a.test/", content: "# A\n\ntext", truncated: true, next: "20000" } }] })); };
const rd = await readUrl({ backend: "container", url: "https://a.test", format: "markdown", maxChars: 5000 }, rf, env);
assert.equal(runs[0][0], "https://mcp.example/cloudy-browser-headless/run");
assert.deepEqual(runs[0][1].steps.map((x) => x.cmd), ["open", "readable"]);
assert.equal(runs[0][1].steps[1].maxChars, 5000);
assert.deepEqual(rd, { ok: true, session: "s9", url: "https://a.test/", title: "A", format: "markdown", content: "# A\n\ntext", truncated: true, next: "20000" });
assert.ok(!/<[a-z][^>]*>/i.test(rd.content), "browser.read returns no HTML tags");
await readUrl({ backend: "container", url: "https://a.test", session: "s9", cursor: "20000" }, rf, env);
assert.deepEqual(runs[1][1].steps.map((x) => x.cmd), ["readable"]);
assert.equal(runs[1][1].steps[0].cursor, "20000");
const failed = await readUrl({ backend: "container", url: "https://a.test" }, async () => new Response(JSON.stringify({ ok: false, session: "s", steps: [{ ok: false, error: { code: "timeout", message: "open timed out" } }] })), env);
assert.equal(failed.ok, false);
assert.equal(failed.error.code, "timeout");
console.log("ok - browser tools (backends, read)");

// ── #1540 bot-wall detection on fixtures ──
const JUST_A_MOMENT = { status: 403, cfMitigated: "challenge", title: "Just a moment...", text: "Performing security verification", marker: true, url: "https://claude.ai/share/x" };
assert.match(detectBotWall(JUST_A_MOMENT), /^cf-mitigated:challenge/);
assert.match(detectBotWall({ status: 200, title: "Just a moment...", text: "Enable JavaScript and cookies to continue", bodyLen: 40 }), /^challenge_title/);
assert.match(detectBotWall({ status: 403, title: "Attention Required! | Cloudflare", text: "Sorry, you have been blocked", bodyLen: 300 }), /^challenge_title/);
assert.match(detectBotWall({ status: 200, title: "claude.ai", text: "Performing security verification. This website uses a security service to protect against malicious bots. Verify you are human", bodyLen: 160 }), /challenge/);
assert.equal(detectBotWall({ status: 503, title: "x", text: "Access denied", bodyLen: 13 })?.startsWith("http_503"), true);
assert.equal(detectBotWall({ status: 429, title: "Too many", text: "<div class=cf-turnstile>", marker: true, bodyLen: 20 }), "http_429+challenge");
assert.equal(detectBotWall({ status: 200, url: "https://a.test/cdn-cgi/challenge-platform/h/b/orchestrate", bodyLen: 0 }), "challenge_redirect+empty_body");
assert.equal(detectBotWall({ status: 302, url: "https://a.test/?challenge_redirect=1", text: "x".repeat(900), bodyLen: 900 }), "challenge_redirect");
assert.equal(detectBotWall({ status: 200, title: "", text: "", bodyLen: 0, marker: true }), "empty_body+challenge_marker");
assert.equal(detectBotWall({ headers: { "cf-mitigated": "challenge" }, status: 403 }), "cf-mitigated:challenge");
// no false positives: a normal page, a long article that mentions captchas, a plain 403 or 503 without a challenge, a login page with a turnstile widget
assert.equal(detectBotWall({ status: 200, title: "Example Domain", text: "Example Domain This domain is for use in illustrative examples", bodyLen: 120 }), null);
assert.equal(detectBotWall({ status: 200, title: "How captchas work", text: "A captcha is a test. ".repeat(400), bodyLen: 8400, marker: false }), null);
assert.equal(detectBotWall({ status: 200, title: "Sign in", text: "Email Password ".repeat(300), bodyLen: 4500, marker: true }), null);
assert.equal(detectBotWall({ status: 503, title: "Maintenance", text: "Back soon", bodyLen: 9 }), null);
assert.equal(detectBotWall({ status: 404, title: "Not found", text: "gone", bodyLen: 4 }), null);
assert.ok(PROBE_JS.includes("cf-turnstile") && PROBE_JS.includes("challenge-platform"));
console.log("ok - bot-wall detection");

// ── gateway fixtures: a router fetch for the container (run), cloudflare (REST) and openrouter ──
const ENV = { C3_BROWSER_URL: "http://c.test:3118", C3_BROWSER_TOKEN: "bt", CF_BROWSER_ACCOUNT_ID: "ACC", CF_BROWSER_API_TOKEN: "cft", OPENROUTER_API_KEY: "ork", C3_PHONE_MESH_URL: "http://p.test", C3_PHONE_FLEET_TOKEN: "pt" };
const CHALLENGE_RUN = { ok: true, session: "s1", steps: [
  { ok: true, result: { url: "https://claude.ai/share/x", title: "Just a moment...", status: 403, cfMitigated: "challenge" } },
  { ok: true, result: { title: "Just a moment...", text: "Performing security verification", bodyLen: 33, marker: true, url: "https://claude.ai/share/x" } },
  { ok: true, result: { url: "https://claude.ai/share/x", title: "Just a moment...", format: "markdown", content: "# Just a moment\n\nPerforming security verification", truncated: false } } ] };
const okRun = (last) => ({ ok: true, session: "s2", steps: [
  { ok: true, result: { url: "https://example.com/", title: "Example Domain", status: 200 } },
  { ok: true, result: { title: "Example Domain", text: "Example Domain This domain is for use in illustrative examples", bodyLen: 120, marker: false, url: "https://example.com/" } },
  { ok: true, result: last } ] });
const mk = (containerReply, cfReplies = {}) => {
  const seen = { container: [], cf: [], or: [] };
  const fn = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.startsWith("http://c.test")) { seen.container.push(body); return new Response(JSON.stringify(typeof containerReply === "function" ? containerReply(body) : containerReply)); }
    if (url.startsWith("https://api.cloudflare.com/client/v4/accounts/ACC/browser-rendering/")) {
      const ep = url.split("/").pop(); seen.cf.push({ ep, body, auth: init.headers.authorization });
      const r = cfReplies[ep];
      if (r?.binary) return new Response(r.binary, { status: 200, headers: { "content-type": r.mime, "x-browser-ms-used": "1500" } });
      return new Response(JSON.stringify(r?.json ?? { success: true, result: "" }), { status: r?.status ?? 200, headers: { "content-type": "application/json", "x-browser-ms-used": String(r?.ms ?? 1200) } });
    }
    if (url.startsWith("https://openrouter.ai/")) { seen.or.push({ body, auth: init.headers.authorization }); return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"Example Domain"}' } }] })); }
    throw new Error("unexpected " + url);
  };
  return { fn, seen };
};
const st = (over = {}, t0 = Date.parse("2026-11-06T10:00:00Z")) => { const clock = { t: t0 }; const s = new BrowserState({ ...configFromEnv({}), ...over }, () => clock.t); return { s, clock }; };

// auto: the container serves example.com, Cloudflare is not called
{
  const { fn, seen } = mk(okRun({ format: "markdown", title: "Example Domain", url: "https://example.com/", content: "# Example Domain", truncated: false }));
  const { s } = st();
  const r = await gateway("read", { url: "https://example.com/" }, { f: fn, env: ENV, state: s });
  assert.equal(r.ok, true); assert.equal(r.backend_used, "container"); assert.equal(r.fallback_reason, null); assert.equal(r.content, "# Example Domain");
  assert.equal(seen.cf.length, 0);
  assert.deepEqual(seen.container[0].steps.map((x) => x.cmd), ["open", "eval", "readable"]);
}
// auto: the container gets a challenge -> the SAME call goes to cloudflare -> backend_used cloudflare, fallback_reason set
{
  const { fn, seen } = mk(CHALLENGE_RUN, { markdown: { json: { success: true, result: "# Shared chat\n\nHello from the claude share." } } });
  const { s } = st();
  const r = await gateway("read", { url: "https://claude.ai/share/x" }, { f: fn, env: ENV, state: s });
  assert.equal(r.backend_used, "cloudflare"); assert.match(r.fallback_reason, /^bot_wall: cf-mitigated:challenge/);
  assert.equal(r.content, "# Shared chat\n\nHello from the claude share."); assert.equal(r.format, "markdown");
  assert.deepEqual(seen.cf.map((c) => c.ep), ["markdown"]); assert.deepEqual(seen.cf[0].body, { url: "https://claude.ai/share/x" }); assert.equal(seen.cf[0].auth, "Bearer cft");
  assert.equal(r.bot_wall, undefined);
  // per-domain memory: the next call goes straight to cloudflare (the container is not asked again)
  const before = seen.container.length;
  const r2 = await gateway("read", { url: "https://claude.ai/share/y" }, { f: fn, env: ENV, state: s });
  assert.equal(r2.backend_used, "cloudflare"); assert.match(r2.fallback_reason, /domain_memory/);
  assert.equal(seen.container.length, before);
  assert.equal(s.usage().domains[0].host, "claude.ai");
  assert.equal(s.calls, 2);
  assert.ok(s.usd > 0, "usage cost logged from X-Browser-Ms-Used");
  assert.equal(s.log[0].op, "read"); assert.equal(s.log[0].backend, "cloudflare"); assert.equal(s.log[0].ms, 1200);
  // other domains still try the container first
  const r3 = await gateway("read", { url: "https://other.test/" }, { f: fn, env: ENV, state: s });
  assert.equal(seen.container.length, before + 1); assert.ok(r3.backend_used);
}
// the memory expires after 24 h and is dropped
{
  const { s, clock } = st();
  s.markNeedsCloudflare("a.test");
  assert.equal(s.needsCloudflare("a.test"), true);
  clock.t += 23 * 3600_000; assert.equal(s.needsCloudflare("a.test"), true);
  clock.t += 2 * 3600_000; assert.equal(s.needsCloudflare("a.test"), false);
  assert.equal(s.needsCloudflare("never.test"), false);
}
// Cloudflare is refused too: the challenge result is returned honestly
{
  const { fn } = mk(CHALLENGE_RUN, { markdown: { json: { success: true, result: "---\ntitle: \"Just a moment...\"\n---\nPerforming security verification" } } });
  const { s } = st();
  const r = await gateway("read", { url: "https://claude.ai/share/x" }, { f: fn, env: ENV, state: s });
  assert.equal(r.backend_used, "cloudflare"); assert.equal(r.bot_wall, true); assert.match(r.note, /refused as well/);
}
// only a token configured: the account id is discovered once from GET /accounts, then used
{
  const urls = [];
  const f2 = async (url, init) => { urls.push(url); if (url.includes("/accounts?per_page=1")) return new Response(JSON.stringify({ result: [{ id: "DISC" }] })); return new Response(JSON.stringify({ success: true, result: "# d" }), { headers: { "content-type": "application/json" } }); };
  const { s } = st();
  const r = await gateway("read", { url: "https://x.test/", backend: "cloudflare" }, { f: f2, env: { CF_API_TOKEN: "tok" }, state: s });
  assert.equal(r.content, "# d"); assert.ok(urls.some((u) => u.includes("/accounts/DISC/browser-rendering/markdown")));
}
// cloudflare not configured: the container's challenge result is returned with the reason
{
  const { fn } = mk(CHALLENGE_RUN);
  const r = await gateway("read", { url: "https://claude.ai/share/x" }, { f: fn, env: { ...ENV, CF_BROWSER_API_TOKEN: "" }, state: st().s });
  assert.equal(r.backend_used, "container"); assert.equal(r.bot_wall, true); assert.match(r.fallback_skipped, /not configured/);
}
// explicit container never falls back, but reports the wall; explicit phone pdf is unsupported
{
  const { fn, seen } = mk(CHALLENGE_RUN);
  const r = await gateway("read", { url: "https://claude.ai/share/x", backend: "container" }, { f: fn, env: ENV, state: st().s });
  assert.equal(r.backend_used, "container"); assert.equal(r.bot_wall, true); assert.equal(seen.cf.length, 0);
  const p = await gateway("pdf", { url: "https://a.test", backend: "phone" }, { f: fn, env: ENV, state: st().s });
  assert.equal(p.ok, false); assert.equal(p.error.code, "unsupported");
  assert.equal(SUPPORT.pdf.phone, false); assert.deepEqual(GW_OPS.length, 8);
}
// daily cap: calls and estimated spend
{
  const { fn, seen } = mk(CHALLENGE_RUN, { markdown: { json: { success: true, result: "# ok" } } });
  const { s, clock } = st({ cfDailyCap: 1 });
  const a = await gateway("read", { url: "https://one.test/" }, { f: fn, env: ENV, state: s });
  assert.equal(a.backend_used, "cloudflare");
  const b = await gateway("read", { url: "https://two.test/" }, { f: fn, env: ENV, state: s });
  assert.equal(b.backend_used, "container"); assert.match(b.fallback_skipped, /daily cloudflare cap reached \(1\/1/); assert.equal(seen.cf.length, 1);
  const c = await gateway("read", { url: "https://one.test/", backend: "cloudflare" }, { f: fn, env: ENV, state: s });
  assert.equal(c.ok, false); assert.equal(c.error.code, "limit");
  clock.t += 24 * 3600_000; // next UTC day: the counter resets
  assert.equal(s.capReason(), null);
  const usd = st({ cfDailyUsdCap: 0.0001 }); usd.s.record({ op: "read", host: "x", backend: "cloudflare", status: 200, ms: 3600_000 });
  assert.match(usd.s.capReason(), /spend cap/);
  assert.equal(configFromEnv({ C3_BROWSER_CF_DAILY_CAP: "7" }).cfDailyCap, 7);
  assert.equal(configFromEnv({ C3_BROWSER_CF_DAILY_CAP: "junk" }).cfDailyCap, 200);
  assert.equal(configFromEnv({}).domainTtlMs, 24 * 3600_000);
}
console.log("ok - fallback flow, domain memory, cap");

// ── each endpoint's request/response mapping (mocked Cloudflare responses) ──
const U = "https://example.com/";
assert.deepEqual(cfConf({ CF_ACCOUNT_ID: "A", CF_API_TOKEN: "T" }), { account: "A", token: "T", base: "https://api.cloudflare.com/client/v4", seg: "browser-rendering" });
assert.equal(cfConf({ CF_ACCOUNT_ID: "A" }), null);
assert.equal(cfConf({ CF_BROWSER_API_TOKEN: "B", CF_API_TOKEN: "T", CF_BROWSER_ACCOUNT_ID: "A" }).token, "B");
assert.deepEqual(cfRequestFor("read", { url: U }), { endpoint: "markdown", body: { url: U }, binary: false });
assert.deepEqual(cfRequestFor("content", { url: U, waitUntil: "networkidle0" }).body, { url: U, gotoOptions: { waitUntil: "networkidle0" } });
assert.deepEqual(cfRequestFor("screenshot", { url: U, fullPage: true, format: "jpeg", quality: 60 }), { endpoint: "screenshot", body: { url: U, screenshotOptions: { fullPage: true, type: "jpeg", quality: 60 } }, binary: true });
assert.deepEqual(cfRequestFor("pdf", { url: U, pdfFormat: "Letter", landscape: true }), { endpoint: "pdf", body: { url: U, pdfOptions: { format: "Letter", landscape: true } }, binary: true });
assert.deepEqual(cfRequestFor("links", { url: U, visibleOnly: true, sameOrigin: true }).body, { url: U, visibleLinksOnly: true, excludeExternalLinks: true });
assert.deepEqual(cfRequestFor("scrape", { url: U, elements: [{ selector: "h1", attrs: ["id"] }] }).body, { url: U, elements: [{ selector: "h1" }] });
assert.deepEqual(cfRequestFor("json", { url: U, prompt: "p", schema: { type: "object" } }).body, { url: U, prompt: "p", response_format: { type: "json_schema", json_schema: { type: "object" } } });
assert.deepEqual(cfRequestFor("snapshot", { url: U, format: "png" }).body, { url: U, screenshotOptions: { type: "png" } });
const ok = (result) => ({ status: 200, ms: 100, json: { success: true, result } });
assert.deepEqual(cfNormalize("content", { url: U }, ok("<html>x</html>")), { ok: true, result: { url: U, html: "<html>x</html>" } });
assert.deepEqual(cfNormalize("links", { url: U }, ok(["https://a/", "https://b/"])).result, { count: 2, links: [{ href: "https://a/" }, { href: "https://b/" }] });
const sc = cfNormalize("scrape", { url: U, elements: [{ selector: "a", attrs: ["href"] }] }, ok([{ selector: "a", results: [{ text: "More", html: "More", attributes: [{ name: "href", value: "https://iana" }, { name: "class", value: "c" }], width: 10, height: 5 }] }]));
assert.deepEqual(sc.result.results[0], { selector: "a", count: 1, items: [{ text: "More", html: "More", attrs: { href: "https://iana" }, visible: true }] });
assert.deepEqual(cfNormalize("json", { url: U }, ok({ title: "T" })).result, { data: { title: "T" } });
const sn = cfNormalize("snapshot", { url: U }, ok({ content: "<p>x</p>", screenshot: "QUJD" }));
assert.deepEqual(sn.result, { url: U, html: "<p>x</p>", screenshot: { mime: "image/png", base64: "QUJD" } });
const bin = cfNormalize("pdf", { url: U }, { status: 200, ms: 1, bytes: new Uint8Array([37, 80, 68, 70]), mime: "application/pdf" });
assert.deepEqual(bin.result, { mime: "application/pdf", base64: "JVBERg==", bytes: 4 });
const rdc = cfNormalize("read", { url: U, format: "json", maxChars: 500 }, ok("m".repeat(1200)));
assert.equal(rdc.result.truncated, true); assert.equal(rdc.result.next, "500"); assert.equal(rdc.result.content.length, 500);
assert.match(cfNormalize("read", { url: U, format: "xml" }, ok("a<b")).result.content, /^<doc><meta u="https:\/\/example.com\/" src="cloudflare"\/><md>a&lt;b<\/md><\/doc>$/);
assert.equal(cfNormalize("read", { url: U }, { status: 401, ms: 0, json: { success: false, errors: [{ message: "Authentication error" }] } }).error.code, "unauthorized");
assert.equal(cfNormalize("read", { url: U }, { status: 429, ms: 0, json: {} }).error.code, "limit");
// every op end-to-end through the cloudflare backend with mocked responses (binary bodies included)
{
  const png = new Uint8Array([137, 80, 78, 71]);
  const { fn, seen } = mk(CHALLENGE_RUN, {
    markdown: { json: { success: true, result: "# md" } }, content: { json: { success: true, result: "<html>r</html>" } },
    screenshot: { binary: png, mime: "image/png" }, pdf: { binary: new Uint8Array([37, 80, 68, 70]), mime: "application/pdf" },
    links: { json: { success: true, result: ["https://example.com/a"] } }, scrape: { json: { success: true, result: [{ selector: "h1", results: [{ text: "Hi", html: "Hi", attributes: [], width: 1, height: 1 }] }] } },
    json: { json: { success: true, result: { t: 1 } } }, snapshot: { json: { success: true, result: { content: "<p/>", screenshot: "QQ==" } } } });
  const s = st().s;
  const run = (op, a) => gateway(op, { url: U, backend: "cloudflare", ...a }, { f: fn, env: ENV, state: s });
  assert.equal((await run("read", {})).content, "# md");
  assert.equal((await run("content", {})).html, "<html>r</html>");
  const shot = await run("screenshot", { fullPage: true }); assert.equal(shot.mime, "image/png"); assert.equal(shot.base64, "iVBORw==");
  assert.equal((await run("pdf", {})).mime, "application/pdf");
  assert.equal((await run("links", {})).count, 1);
  assert.equal((await run("scrape", { elements: [{ selector: "h1" }] })).results[0].items[0].text, "Hi");
  assert.deepEqual((await run("json", { prompt: "p" })).data, { t: 1 });
  assert.equal((await run("snapshot", {})).screenshot.base64, "QQ==");
  assert.deepEqual(seen.cf.map((c) => c.ep), ["markdown", "content", "screenshot", "pdf", "links", "scrape", "json", "snapshot"]);
  assert.equal(s.calls, 8); assert.equal(s.log.every((e) => e.backend === "cloudflare"), true);
}
// container/phone session mapping of each op (one run: open, probe, command)
{
  const wanted = { content: ["content", {}], screenshot: ["screenshot", { fullPage: true, format: "jpeg", quality: 50 }], pdf: ["pdf", { landscape: true }], links: ["links", { sameOrigin: true }], scrape: ["scrape", { elements: [{ selector: "a" }] }], snapshot: ["snapshot", {}] };
  for (const [op, [cmd, a]] of Object.entries(wanted)) {
    const { fn, seen } = mk(okRun(op === "content" ? "<html/>" : { mime: "image/png", base64: "QQ==" }));
    const r = await gateway(op, { url: U, backend: "container", ...a }, { f: fn, env: ENV, state: st().s });
    assert.equal(r.ok, true, op); assert.equal(seen.container[0].steps[2].cmd, cmd);
    assert.equal(r.backend_used, "container");
  }
  const { fn, seen } = mk(okRun({ format: "markdown", content: "# Example Domain\n\nIllustrative." }));
  const j = await gateway("json", { url: U, prompt: "title", schema: { type: "object", required: ["title", "n"], properties: { title: { type: "string" } } } }, { f: fn, env: ENV, state: st().s });
  assert.deepEqual(j.data, { title: "Example Domain" }); assert.deepEqual(j.schema_errors, ["$.n: required"]);
  assert.equal(seen.or[0].auth, "Bearer ork"); assert.equal(seen.or[0].body.response_format.type, "json_schema"); assert.equal(seen.cf.length, 0);
  const nokey = await extractJsonViaOpenRouter("x", { url: U }, fn, {}); assert.equal(nokey.error.code, "not_configured");
}
console.log("ok - endpoint mappings");

// ── schema validation ──
assert.deepEqual(validateAgainstSchema({ a: 1, b: ["x"] }, { type: "object", required: ["a"], properties: { a: { type: "integer" }, b: { type: "array", items: { type: "string" } } } }), []);
assert.deepEqual(validateAgainstSchema({ a: "1", b: [2] }, { type: "object", properties: { a: { type: "integer" }, b: { type: "array", items: { type: "string" } } } }), ["$.a: expected integer, got string", "$.b[0]: expected string, got number"]);
assert.deepEqual(validateAgainstSchema("z", { enum: ["a", "b"] }), ["$: not in enum"]);
// the shared headless-api.json (cloudy-u-android) is checked when the sibling repo is present: every gateway op is declared, support matrix agrees
import { readFileSync } from "node:fs";
for (const p of ["../../../../cloudy-u-android/ab_cloud-libs-shared/libs/headless-api/headless-api.json", "../../../../../cloudy-u-android/ab_cloud-libs-shared/libs/headless-api/headless-api.json"]) {
  let sch; try { sch = JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8")); } catch { continue; }
  console.log("schema checked:", p);
  for (const op of ["content", "pdf", "links", "scrape", "snapshot"]) assert.ok(sch.commands[op], `schema declares ${op}`);
  assert.deepEqual(Object.keys(sch.gateway.tools).sort(), GW_OPS.filter((o) => o !== "json").concat("json").map((o) => `browser.${o}`).sort());
  for (const op of GW_OPS) { const sup = sch.gateway.support[op]; assert.equal(!!sup.phone, SUPPORT[op].phone, `${op} phone support`); }
  assert.equal(sch.gateway.defaultBackend, "auto");
}
console.log("ok - schema validation");
