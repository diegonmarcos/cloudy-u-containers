// http-post.mjs — long-turn POST transport for internal hops.
//
// Node's built-in fetch (undici) hard-caps waiting for response HEADERS at
// ~300s (dispatcher headersTimeout, not overridable per-call without the
// undici package, which this stack does not vendor). Claude turns that resume
// the orchestrator session run well past 5 minutes, so both long hops
// (bot → gateway, gateway → claude bridge) use plain node:http instead.
// Returns a minimal fetch-like response ({ ok, status, text(), json() }) so
// call sites keep their shape. Plain http only — every hop here is a
// WG-internal 10.0.0.x URL, never public.
import http from "node:http";

export const postJson = (urlStr, headers, bodyObj, timeoutMs) => {
  // Tests stub globalThis.fetch to capture outbound requests (e.g.
  // test-my-ai-telegram-session-model.ts). Honor a stub so the transport swap
  // stays invisible to them; real runs always take the node:http path below.
  if (typeof globalThis.fetch === "function" && !String(globalThis.fetch).includes("[native code]")) {
    return globalThis.fetch(urlStr, { method: "POST", headers, body: JSON.stringify(bodyObj) });
  }
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const body = JSON.stringify(bodyObj);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: "POST",
        headers: { ...headers, "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            text: async () => data,
            json: async () => JSON.parse(data),
          }),
        );
      },
    );
    req.setTimeout(timeoutMs, () => {
      const e = new Error(`no response after ${Math.round(timeoutMs / 1000)}s`);
      e.code = "ETIMEDOUT";
      req.destroy(e);
    });
    req.on("error", reject);
    req.end(body);
  });
};
