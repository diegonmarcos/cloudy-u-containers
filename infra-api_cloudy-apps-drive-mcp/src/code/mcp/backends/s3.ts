// s3.ts — S3-compatible object access (OCI Object Storage).
//
// AWS SigV4 in ~60 lines of node:crypto rather than pulling in @aws-sdk, which
// would be several MB of dependency to sign four request shapes. Path-style
// addressing, because OCI's S3 compat endpoint does not do virtual-host style.
//
// Credentials come from the environment (sops-injected: the OCI_S3_ACCESS_KEY /
// OCI_S3_SECRET_KEY pair already exists for photoprism). Nothing is defaulted —
// an unset endpoint or bucket is reported, never guessed.

import { createHash, createHmac } from "node:crypto";
import { send, type Reply } from "../request.js";

type Json = Record<string, any>;

const sha256 = (d: string | Buffer) => createHash("sha256").update(d).digest("hex");
const hmac = (k: Buffer | string, d: string) => createHmac("sha256", k).update(d).digest();

function signingKey(secret: string, date: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), "s3"), "aws4_request");
}

/** RFC3986 escape — S3 requires the stricter form, encodeURIComponent leaves !'()* alone. */
function uriEscape(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

function encodeKeyPath(key: string): string {
  return key.split("/").map(uriEscape).join("/");
}

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export function s3Config(backend: Json): S3Config | { error: string } {
  const get = (k: string) => (backend[k] ? process.env[backend[k]] : undefined);
  const endpoint = get("endpoint_env");
  const bucket = get("bucket_env");
  const accessKey = get("access_key_env");
  const secretKey = get("secret_key_env");
  const region = get("region_env") ?? "us-ashburn-1";

  const missing = [
    !endpoint && backend.endpoint_env,
    !bucket && backend.bucket_env,
    !accessKey && backend.access_key_env,
    !secretKey && backend.secret_key_env,
  ].filter(Boolean);

  if (missing.length) {
    return { error: `s3 backend not configured — unset: ${missing.join(", ")}` };
  }
  return {
    endpoint: endpoint!.replace(/\/+$/, ""),
    region,
    bucket: bucket!,
    accessKey: accessKey!,
    secretKey: secretKey!,
  };
}

async function signedRequest(
  cfg: S3Config,
  method: string,
  keyPath: string,
  query: Record<string, string>,
  body: Buffer,
): Promise<Reply> {
  const url = new URL(cfg.endpoint);
  const canonicalUri = `/${uriEscape(cfg.bucket)}${keyPath ? "/" + encodeKeyPath(keyPath) : ""}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");   // 20260824T161500Z
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256(body);

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEscape(k)}=${uriEscape(query[k])}`)
    .join("&");

  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers).sort().map((h) => `${h}:${headers[h]}\n`).join("");

  const canonicalRequest = [
    method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signature = createHmac("sha256", signingKey(cfg.secretKey, dateStamp, cfg.region))
    .update(stringToSign).digest("hex");

  headers["Authorization"] =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const qs = canonicalQuery ? `?${canonicalQuery}` : "";
  return send(method, `${cfg.endpoint}${canonicalUri}${qs}`, body.length ? body : undefined, headers);
}

export async function s3Call(backend: Json, op: string, params: Json): Promise<Json> {
  const cfg = s3Config(backend);
  if ("error" in cfg) return cfg;

  const key = String(params.key ?? "");
  const empty = Buffer.alloc(0);

  switch (op) {
    case "list": {
      const q: Record<string, string> = { "list-type": "2" };
      if (params.prefix) q.prefix = String(params.prefix);
      if (params.max) q["max-keys"] = String(params.max);
      const r = await signedRequest(cfg, "GET", "", q, empty);
      return r.ok ? { bucket: cfg.bucket, listing: r.data } : { error: r.error ?? `HTTP ${r.status}`, body: r.data };
    }
    case "get": {
      if (!key) return { error: "s3.get needs params.key" };
      const r = await signedRequest(cfg, "GET", key, {}, empty);
      return r.ok ? { key, object: r.data } : { error: r.error ?? `HTTP ${r.status}`, body: r.data };
    }
    case "put": {
      if (!key) return { error: "s3.put needs params.key" };
      if (params.content === undefined) return { error: "s3.put needs params.content" };
      const body = params.base64
        ? Buffer.from(String(params.content), "base64")
        : Buffer.from(String(params.content), "utf-8");
      const r = await signedRequest(cfg, "PUT", key, {}, body);
      return r.ok ? { key, bytes: body.length, ok: true } : { error: r.error ?? `HTTP ${r.status}`, body: r.data };
    }
    case "delete": {
      if (!key) return { error: "s3.delete needs params.key" };
      const r = await signedRequest(cfg, "DELETE", key, {}, empty);
      return r.ok ? { key, deleted: true } : { error: r.error ?? `HTTP ${r.status}`, body: r.data };
    }
    default:
      return { error: `unknown s3 op: ${op}` };
  }
}
