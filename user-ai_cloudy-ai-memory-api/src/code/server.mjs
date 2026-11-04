#!/usr/bin/env node
// session-memory — central SQLite store of all Claude Code session transcripts, so a
// session started on one device can be listed / fetched / resumed from any other.
// WG-only sidecar on oci-apps. Node 22 built-in node:sqlite (no native deps → also
// runnable on the phone). Devices PUT their ~/.claude/projects/*/<id>.jsonl here.
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const PORT = parseInt(process.env.MEM_PORT || "3108", 10);
const BIND = process.env.MEM_BIND || "10.0.0.6";
const DB_PATH = process.env.MEM_DB || "/data/sessions.db";
const TOKEN = process.env.MEM_TOKEN || "";            // optional shared token (WG already gates)

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    device      TEXT,
    project     TEXT,
    cwd         TEXT,
    bytes       INTEGER,
    lines       INTEGER,
    updated_at  INTEGER,
    transcript  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
`);
const upsert = db.prepare(`
  INSERT INTO sessions (id, device, project, cwd, bytes, lines, updated_at, transcript)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET device=excluded.device, project=excluded.project,
    cwd=excluded.cwd, bytes=excluded.bytes, lines=excluded.lines,
    updated_at=excluded.updated_at, transcript=excluded.transcript`);
const listStmt = db.prepare(`SELECT id, device, project, cwd, bytes, lines, updated_at FROM sessions ORDER BY updated_at DESC LIMIT ?`);
const getStmt  = db.prepare(`SELECT * FROM sessions WHERE id = ?`);
const delStmt  = db.prepare(`DELETE FROM sessions WHERE id = ?`);

const readBody = (req) => new Promise((res, rej) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => res(b)); req.on("error", rej); });
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "x"}`);
  const p = url.pathname;
  if (req.method === "GET" && (p === "/health" || p === "/")) {
    const n = db.prepare("SELECT count(*) c, coalesce(sum(bytes),0) b FROM sessions").get();
    return json(res, 200, { status: "ok", sessions: n.c, bytes: n.b, db: DB_PATH });
  }
  if (TOKEN && req.headers["x-mem-token"] !== TOKEN) return json(res, 401, { error: "bad token" });

  // PUT /sessions/<id>  — body = raw .jsonl transcript; headers carry metadata
  const m = p.match(/^\/sessions\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (req.method === "PUT" || req.method === "POST") {
      const body = await readBody(req);
      upsert.run(id, req.headers["x-device"] || "", req.headers["x-project"] || "",
        req.headers["x-cwd"] || "", Buffer.byteLength(body), body.split("\n").filter(Boolean).length,
        Math.floor(Date.now() / 1000), body);
      return json(res, 200, { ok: true, id, bytes: Buffer.byteLength(body) });
    }
    if (req.method === "GET") {
      const row = getStmt.get(id);
      if (!row) return json(res, 404, { error: "not found" });
      if (url.searchParams.get("raw") === "1") { res.writeHead(200, { "content-type": "application/x-ndjson" }); return res.end(row.transcript); }
      return json(res, 200, { ...row, transcript: undefined, has_transcript: !!row.transcript });
    }
    if (req.method === "DELETE") { delStmt.run(id); return json(res, 200, { ok: true, id }); }
  }
  // GET /sessions  — list (newest first)
  if (req.method === "GET" && p === "/sessions") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "100", 10), 1000);
    return json(res, 200, { sessions: listStmt.all(limit) });
  }
  json(res, 404, { error: "not found" });
});

server.listen(PORT, BIND, () => console.error(`[session-memory] http://${BIND}:${PORT} db=${DB_PATH}${TOKEN ? " (token)" : ""}`));
