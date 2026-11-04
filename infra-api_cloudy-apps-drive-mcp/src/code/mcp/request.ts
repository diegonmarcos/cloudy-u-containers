// request.ts — one blocking-free HTTP helper shared by every http backend.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface Reply {
  ok: boolean;
  status: number;
  data: any;
  error?: string;
}

/**
 * Fill {placeholders} in a route from params. Keys consumed by the path are
 * removed from `rest`, so they cannot reappear as a query param or body field.
 * Lives here rather than in the tool because it is pure request construction —
 * and because keeping it dependency-free is what makes it testable.
 */
export function fillPath(
  template: string,
  params: Record<string, any>,
): { path: string; rest: Record<string, any>; missing: string[] } {
  const rest = { ...params };
  const missing: string[] = [];
  const path = template.replace(/\{(\w+)\}/g, (_m, key) => {
    if (rest[key] === undefined || rest[key] === null || rest[key] === "") {
      missing.push(key);
      return "";
    }
    const v = String(rest[key]);
    delete rest[key];
    // Path segments may legitimately contain '/', so escape per segment.
    return v.split("/").map(encodeURIComponent).join("/");
  });
  return { path, rest, missing };
}

export function send(
  method: string,
  url: string,
  body?: string | Buffer,
  headers: Record<string, string> = {},
  timeoutMs = 20_000,
): Promise<Reply> {
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      resolve({ ok: false, status: 0, data: null, error: `malformed url: ${url}` });
      return;
    }

    const send = u.protocol === "https:" ? httpsRequest : httpRequest;
    const hdrs = { ...headers };
    if (body !== undefined && hdrs["Content-Length"] === undefined) {
      hdrs["Content-Length"] = String(Buffer.byteLength(body));
    }

    const req = send(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: hdrs },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const status = res.statusCode ?? 0;
          const ctype = String(res.headers["content-type"] ?? "");
          let data: any;
          if (ctype.includes("json")) {
            try { data = JSON.parse(raw.toString("utf-8")); } catch { data = raw.toString("utf-8"); }
          } else if (ctype.startsWith("text/") || ctype.includes("xml")) {
            data = raw.toString("utf-8");
          } else {
            // Binary stays binary — an S3 object is not necessarily text.
            data = raw.length > 0 ? { _binary: true, bytes: raw.length, base64: raw.toString("base64") } : null;
          }
          resolve({ ok: status >= 200 && status < 300, status, data });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve({ ok: false, status: 0, data: null, error: `timeout after ${timeoutMs}ms` });
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, data: null, error: String(e) }));
    if (body !== undefined) req.write(body);
    req.end();
  });
}
