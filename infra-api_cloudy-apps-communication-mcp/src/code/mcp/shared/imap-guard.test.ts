// An IMAP "error" event must never crash the server. Run: node --test imap-guard.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { guardImapErrors } from "./imap-guard.ts";

test("unguarded emitter throws on 'error' (the 03:10 crash)", () => {
  const e = new EventEmitter();
  assert.throws(() => e.emit("error", Object.assign(new Error("Socket timeout"), { code: "ETIMEOUT" })));
});

test("guarded emitter swallows 'error' and logs it", () => {
  const e = new EventEmitter();
  const seen: string[] = [];
  const orig = console.error;
  console.error = (m: string) => { seen.push(m); };
  try {
    guardImapErrors(e, "stalwart/me");
    assert.doesNotThrow(() => e.emit("error", Object.assign(new Error("Socket timeout"), { code: "ETIMEOUT" })));
  } finally { console.error = orig; }
  assert.equal(seen.length, 1);
  assert.match(seen[0], /stalwart\/me.*ETIMEOUT: Socket timeout/);
});

test("withImap guards every client before connect()", () => {
  const src = readFileSync(new URL("./imap.ts", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export async function withImap"));
  const g = body.indexOf("guardImapErrors(client");
  const c = body.indexOf("await client.connect()");
  assert.ok(g > 0 && c > 0 && g < c, "guardImapErrors must run before client.connect()");
  assert.equal((src.match(/new ImapFlow\(/g) ?? []).length, 1, "only withImap creates ImapFlow clients");
});
