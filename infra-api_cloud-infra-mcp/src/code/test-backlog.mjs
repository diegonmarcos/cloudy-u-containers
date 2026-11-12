// #1585: the c3 MCP backlog.* policy never deletes or blanks a ticket.
import assert from "node:assert/strict";
import { test } from "node:test";
import { validId, validSession, indexFromTree, nextId, newTicket, mergeUpdate, TASKS_DIR } from "./mcp/tools/backlog.ts";

const base = { id: "42", subject: "#42 thing", description: "spec", status: "pending", metadata: { progress: "a" } };

test("ids and session folders are validated", () => {
  assert.equal(validId("#1585"), "1585");
  assert.throws(() => validId("../1"));
  assert.throws(() => validSession("../x"));
  assert.equal(validSession("0172rQF2sCRHaeMtr1E7pzQ8"), "0172rQF2sCRHaeMtr1E7pzQ8");
});

test("tree index and next id", () => {
  const idx = indexFromTree([`${TASKS_DIR}/s1abcdef/7.json`, `${TASKS_DIR}/s2abcdef/12.json`, "other/9.json", `${TASKS_DIR}/s1abcdef/x.json`]);
  assert.deepEqual([...idx.keys()].sort(), ["12", "7"]);
  assert.equal(nextId(idx), "13");
});

test("new tickets need subject and description", () => {
  assert.throws(() => newTicket("5", "", "d"));
  assert.throws(() => newTicket("5", "s", " "));
  const t = newTicket("5", "Do it", "spec");
  assert.equal(t.subject, "#5 Do it");
  assert.equal(t.status, "pending");
});

test("update refuses blanking, deletion and unknown fields", () => {
  assert.throws(() => mergeUpdate(base, { subject: " " }));
  assert.throws(() => mergeUpdate(base, { status: "deleted" }));
  assert.throws(() => mergeUpdate(base, { description: "" }));
  assert.throws(() => mergeUpdate(base, { done: "" }));
  assert.throws(() => mergeUpdate(null, { status: "completed" }));
});

test("update appends progress and closes with a date", () => {
  const t = mergeUpdate(base, { progress: "b", status: "completed", done: "x", description_append: "more" }, "2026-11-12");
  assert.equal(t.metadata.progress, "a\n2026-11-12: b");
  assert.equal(t.metadata.closed, "2026-11-12");
  assert.equal(t.description, "spec\n\nmore");
  assert.equal(base.metadata.progress, "a", "input not mutated");
});
