// Tester: ticket #513 — `/resume` must see a session from ANY device and must
// be able to read a Claude Code transcript, not just the bot's own writes.
// Runs on every push via .github/workflows/per-service-tests.yml (registered in
// build.json tests.resume-cross-device, cwd=src/code).
//
// It drives the REAL commands.mjs / route.mjs / sessions-store.mjs against a
// temp BRIDGE_SESSIONS_DIR and a fetch stub that mirrors server.mjs's /sessions
// endpoints — including the ?tail= bound, which it serves through the real
// readTailBytes rather than a re-implementation.
//
// THE FIXTURE IS NOT INVENTED. Every Claude-Code-shaped line below is a verbatim
// copy of a real line out of the real store, read on 2026-09-18 from
//   /home/appuser/.goose-sessions/localhost/6f096941-091d-4b8f-a3bd-03c6f7bc8287.jsonl
// inside the running my-ai-api container (9,006 lines, 127,487,011 bytes). The
// line number each one came from is in its comment. Asserting against a fixture
// written in the new format would prove nothing, because we chose the format.
//
// Reverting either half of the fix turns a check red:
//   * restore `filter((s) => s.device === "telegram")` in /resume -> check A red.
//   * feed these records to the old `m?.role && m?.content !== undefined`
//     predicate -> check B red (and check E asserts that predicate scores ZERO
//     on this fixture, so the fixture cannot silently stop being the hard case).
//
// Usage: node test-my-ai-resume-cross-device.mjs   (exit 0 = PASS)
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "myai-resume-513-"));
process.env.BRIDGE_SESSIONS_DIR = TMP;
// Small bounds so the tester actually exercises the truncation path rather than
// asserting a limit nothing reaches.
process.env.BRIDGE_RESUME_MAX_MESSAGES = "3";
process.env.BRIDGE_RESUME_MAX_BYTES = "50000";
process.env.BRIDGE_RESUME_MAX_LISTED = "40";

const storeUrl = new URL("./sessions-store.mjs", import.meta.url).href;
const routeUrl = new URL("./bots/route.mjs", import.meta.url).href;
const cmdsUrl = new URL("./bots/commands.mjs", import.meta.url).href;
const store = await import(storeUrl);
const route = await import(routeUrl);
const cmds = await import(cmdsUrl);

const failures = [];
const ok = (l) => console.log(`  OK: ${l}`);
const bad = (l) => { failures.push(l); console.log(`FAIL: ${l}`); };
const check = (cond, label) => (cond ? ok(label) : bad(label));

// ── REAL lines, copied verbatim out of the real session file ────────────────
// line 53 — user message, content is an ARRAY of typed blocks
const REAL_USER_BLOCKS = `{"type":"user","uuid":"02abc91a-46b9-4786-830f-a94c416de875","parentUuid":"0f435c6d-070a-47a1-a00b-49e892d2937f","timestamp":"2026-09-10T09:54:56.584Z","sessionId":"6f096941-091d-4b8f-a3bd-03c6f7bc8287","cwd":"/data/data/com.termux.nix/files/home","version":"2.1.226","userType":"external","isSidechain":false,"message":{"role":"user","content":[{"type":"text","text":"go"}]}}`;
// line 7022 — user message, content is a plain STRING (86 of these in the file)
const REAL_USER_STRING = `{"parentUuid":"594440e2-1167-4708-b4e9-85f8c7445c36","isSidechain":false,"promptId":"b6cafe81-79d6-4744-b49e-8452553cb6f3","type":"user","message":{"role":"user","content":"go"},"uuid":"82f34aa1-5bf6-4b7d-ae6b-8ae9621071cf","timestamp":"2026-09-18T09:38:07.110Z","permissionMode":"bypassPermissions","origin":{"kind":"human"},"promptSource":"typed","userType":"external","entrypoint":"cli","cwd":"/data/data/com.termux.nix/files/home","sessionId":"6f096941-091d-4b8f-a3bd-03c6f7bc8287","version":"2.1.226","gitBranch":"master","slug":"quiet-kindling-whisper"}`;
// line 10 — assistant message, array content
const REAL_ASSISTANT = `{"type":"assistant","uuid":"a1bd42c2-5bff-4911-adb1-950b5999e169","parentUuid":"9bd36437-2ff7-4024-b6ce-fdd15ae3250b","timestamp":"2026-09-10T05:29:24.455Z","sessionId":"6f096941-091d-4b8f-a3bd-03c6f7bc8287","cwd":"/data/data/com.termux.nix/files/home","version":"2.1.226","userType":"external","isSidechain":false,"message":{"role":"assistant","content":[{"type":"text","text":"No response requested."}],"model":"<synthetic>"}}`;
// line 3449 — user message whose only block is a tool_result
const REAL_TOOL_RESULT = `{"parentUuid":"0846cb89-5c7d-418b-8621-4c55d8ceb010","isSidechain":false,"promptId":"71deedee-326f-4b39-8929-c4e86e176960","type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Exit code 1\\n0\\n0","is_error":true,"tool_use_id":"toolu_0186f7dKbDqneoThm38orDdh"}]},"uuid":"80955c19-b731-4684-8de8-d8a200c10996","timestamp":"2026-09-17T23:55:44.465Z","toolUseResult":"Error: Exit code 1\\n0\\n0","sourceToolAssistantUUID":"0846cb89-5c7d-418b-8621-4c55d8ceb010","session_id":"fe4542f0-8285-4580-bfd7-7aaf2f819fe2","userType":"external","entrypoint":"cli","cwd":"/data/data/com.termux.nix/files/home/git/cloud-u-android","sessionId":"6f096941-091d-4b8f-a3bd-03c6f7bc8287","version":"2.1.226","gitBranch":"master","slug":"quiet-kindling-whisper"}`;
// lines 723 / 739 / 722 / 5408 / 7196 — NOT messages. Must be skipped, must not crash.
const REAL_NON_MESSAGES = [
  `{"type":"last-prompt","leafUuid":"93f99602-d4a2-44db-898e-278eb2fca95e","sessionId":"6f096941-091d-4b8f-a3bd-03c6f7bc8287"}`,
  `{"type":"mode","mode":"normal","sessionId":"6f096941-091d-4b8f-a3bd-03c6f7bc8287"}`,
  `{"type":"custom-title","customTitle":"tasks","sessionId":"6f096941-091d-4b8f-a3bd-03c6f7bc8287"}`,
  `{"parentUuid":"369ce9da-e7dc-431d-87aa-809ff6040304","isSidechain":false,"attachment":{"type":"date_change","newDate":"2026-09-18"},"type":"attachment","uuid":"a0dce2dd-9fc6-4a4e-9b7b-4b5a630f4029","timestamp":"2026-09-18T06:05:40.476Z","session_id":"fe4542f0-8285-4580-bfd7-7aaf2f819fe2","userType":"external","entrypoint":"cli","cwd":"/data/data/com.termux.nix/files/home","sessionId":"6f096941-091d-4b8f-a3bd-03c6f7bc8287","version":"2.1.226","gitBranch":"master","slug":"quiet-kindling-whisper"}`,
  `{"parentUuid":"a0aacfb9-b7bd-4569-b734-b55d1ddfbfd5","isSidechain":false,"type":"system","subtype":"turn_duration","durationMs":147385,"messageCount":238,"timestamp":"2026-09-18T09:55:03.381Z","uuid":"8d55e344-2123-4619-8ebd-1dc31d02acf7","isMeta":false,"userType":"external","entrypoint":"cli","cwd":"/data/data/com.termux.nix/files/home","sessionId":"6f096941-091d-4b8f-a3bd-03c6f7bc8287","version":"2.1.226","gitBranch":"master","slug":"quiet-kindling-whisper"}`,
];
const REAL_MESSAGES = [REAL_USER_BLOCKS, REAL_ASSISTANT, REAL_USER_STRING, REAL_TOOL_RESULT];
const REAL_BLOCK = [...REAL_MESSAGES, ...REAL_NON_MESSAGES].join("\n");

// The real session id, under the real device directory it actually lives in.
const REAL_ID = "6f096941-091d-4b8f-a3bd-03c6f7bc8287";
const DUP_ID = "aa11bb22-cc33-dd44-ee55-ff6677889900";
const TG_ID = "telegram-claude_99900112233";
const CHAT = "telegram-claude:99900112233";

const writeSession = (device, id, body, mtimeSec) => {
  mkdirSync(join(TMP, device), { recursive: true });
  const f = join(TMP, device, `${id}.jsonl`);
  writeFileSync(f, body.endsWith("\n") ? body : `${body}\n`);
  if (mtimeSec) utimesSync(f, mtimeSec, mtimeSec);
  return f;
};

// A transcript big enough that a 50,000-byte tail is a real truncation (200
// repeats of the real block ≈ 680 KB), so the bound is exercised, not asserted.
const BIG = Array.from({ length: 200 }, () => REAL_BLOCK).join("\n");
const realFile = writeSession("localhost", REAL_ID, BIG, 1789760862);
writeSession("surface-nixos", DUP_ID, REAL_BLOCK, 1788011471);
writeSession("localhost", DUP_ID, REAL_BLOCK, 1789761000); // newer copy of the same id
// 25 newer decoy sessions, so the one the ticket is about sits at rank 26 —
// deeper than the 10 the listing used to show. Measured live on 2026-09-18,
// Diego's session was rank 18 of 40 and the hardcoded slice(0, 10) hid it.
for (let i = 0; i < 25; i++) {
  writeSession("localhost", `decoy-${String(i).padStart(2, "0")}`, REAL_BLOCK, 1789900000 + i);
}

// The bot's own flat {role, content} NDJSON — /resume must keep working on it.
writeSession("telegram", TG_ID, store.serializeHistory([
  { role: "user", content: "telegram turn one" },
  { role: "assistant", content: "telegram reply one" },
]), 1789700000);

// ── fetch stub: server.mjs's /sessions surface, tail included ────────────────
globalThis.fetch = async (url) => {
  const u = String(url);
  const m = u.match(/\/sessions\/([^/?]+)\/([^/?]+)(?:\?(.*))?$/);
  if (m) {
    const file = join(TMP, m[1], `${decodeURIComponent(m[2])}.jsonl`);
    if (!existsSync(file)) return { ok: false, status: 404, text: async () => "" };
    const tail = parseInt(new URLSearchParams(m[3] || "").get("tail") || "0", 10) || 0;
    const size = statSync(file).size;
    // Same call server.mjs makes — the tester must not own a second tail reader.
    const body = tail > 0 && tail < size ? store.readTailBytes(file, tail) : store.readTailBytes(file, 0);
    return { ok: true, status: 200, text: async () => body, json: async () => ({}) };
  }
  if (u.includes("/sessions")) {
    const out = [];
    for (const device of readdirSync(TMP)) {
      const ddir = join(TMP, device);
      if (!statSync(ddir).isDirectory()) continue;
      for (const f of readdirSync(ddir)) {
        if (!f.endsWith(".jsonl")) continue;
        const st = statSync(join(ddir, f));
        // Same namer server.mjs calls (#516) — this stub must keep mirroring the
        // real endpoint's row, for the same reason it uses the real readTailBytes
        // above rather than a second tail reader of its own.
        const { name, from } = store.deriveSessionName(join(ddir, f));
        out.push({ device, id: f.slice(0, -6), mtime: st.mtimeMs, size: st.size, name, name_from: from });
      }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(out), json: async () => out };
  }
  throw new Error(`unexpected fetch: ${u}`);
};

const meta = { fromId: "0", allowFrom: ["0"] };
const resume = (a) => cmds.handleCommand("resume", a, CHAT, meta, "claude");

// ── A. the device filter ─────────────────────────────────────────────────────
// RED if /resume goes back to filter((s) => s.device === "telegram").
const listing = await resume("");
check(listing.includes(REAL_ID) && listing.includes("localhost"),
  `/resume lists a session from a NON-telegram device (id + device shown) — got: ${JSON.stringify(listing.slice(0, 180))}`);
check(!listing.includes("no saved sessions for this device"),
  "/resume no longer answers \"(no saved sessions for this device)\" with a populated store");
// RED if the listing goes back to a hardcoded slice(0, 10): the target session
// is the 26th newest here, exactly the position the live store put it in.
//
// Rank is measured by the ORDER the ids appear in the reply, not by line number:
// #516 gave each row a name on its own line above the id, and a probe that
// assumed one line per row would report rank 0 on a listing that is perfectly
// correct. What this check is about is how DEEP the listing reaches, so it reads
// order and nothing about layout.
const rankOf = (text, id) => {
  const seen = [...new Set([REAL_ID, DUP_ID, TG_ID,
    ...Array.from({ length: 25 }, (_, i) => `decoy-${String(i).padStart(2, "0")}`)])]
    .map((x) => ({ x, at: text.indexOf(x) }))
    .filter((e) => e.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((e) => e.x);
  return seen.indexOf(id) + 1;
};
const rank = rankOf(listing, REAL_ID);
check(rank > 10, `the listing reaches past the 10 newest — the target session is listed at rank ${rank}`);

// ── B. the parser ────────────────────────────────────────────────────────────
// RED if a Claude Code shaped record yields zero messages.
const resumed = await resume(REAL_ID);
const loadedHistory = route.getState(CHAT, "claude").history;
check(loadedHistory.length > 0 && resumed.startsWith("▶️"),
  `/resume of a Claude Code transcript yields messages — got: ${JSON.stringify(resumed.slice(0, 200))}`);
check(!resumed.includes("had no readable messages"),
  "/resume of a Claude Code transcript does not dead-end on \"no readable messages\"");
check(resumed.includes("localhost"), "/resume names the device it resolved the id from");

// ── C. non-message records are skipped, not crashed on ──────────────────────
let crashed = null;
let skippedAll = true;
for (const line of REAL_NON_MESSAGES) {
  try { if (store.normalizeSessionRecord(JSON.parse(line)) !== null) skippedAll = false; }
  catch (e) { crashed = e.message; }
}
check(crashed === null, `real non-message records (last-prompt/mode/custom-title/attachment/system) do not throw${crashed ? ` — threw: ${crashed}` : ""}`);
check(skippedAll, "real non-message records normalise to null (skipped, not resumed as messages)");

// ── D. typed content blocks flatten to text ─────────────────────────────────
const one = (line) => store.normalizeSessionRecord(JSON.parse(line));
check(one(REAL_USER_BLOCKS)?.content === "go", "array-of-blocks content flattens to its text");
check(one(REAL_USER_STRING)?.content === "go", "plain-string content is read as-is");
check(one(REAL_ASSISTANT)?.role === "assistant" && one(REAL_ASSISTANT)?.content === "No response requested.",
  "assistant record keeps its role and flattens its text");
check(one(REAL_TOOL_RESULT)?.content.includes("Exit code 1"), "tool_result block flattens to its result text");
check(one(`{"role":"user","content":"flat bot line"}`)?.content === "flat bot line",
  "the bot's own flat {role, content} line still normalises (no regression on the telegram write path)");

// ── E. anti-vacuity: the OLD predicate must score ZERO on this fixture ──────
// If a future edit "simplifies" these fixtures into the flat shape, the old
// parser would pass on them and check B would stop proving anything. This
// check fails loudly if that ever happens.
const oldParserHits = REAL_MESSAGES.filter((l) => { const m = JSON.parse(l); return m?.role && m?.content !== undefined; }).length;
check(oldParserHits === 0,
  `the pre-fix predicate (m?.role && m?.content !== undefined) finds ZERO messages in this fixture — got ${oldParserHits}, so the fixture is still the shape that used to break`);

// ── F. the bound ─────────────────────────────────────────────────────────────
check(loadedHistory.length <= Number(process.env.BRIDGE_RESUME_MAX_MESSAGES),
  `resumed history is capped at BRIDGE_RESUME_MAX_MESSAGES (${process.env.BRIDGE_RESUME_MAX_MESSAGES}) — got ${loadedHistory.length}`);
check(/older not loaded/.test(resumed) && !/\(0 B older not loaded\)/.test(resumed),
  `/resume states how much was skipped instead of truncating silently — got: ${JSON.stringify(resumed)}`);
const tailText = store.readTailBytes(realFile, 50000);
const tailLines = tailText.split("\n").filter(Boolean);
let tailWhole = tailLines.length > 0;
for (const l of tailLines) { try { JSON.parse(l); } catch { tailWhole = false; } }
check(Buffer.byteLength(tailText) < statSync(realFile).size && tailWhole,
  "readTailBytes returns only the tail, and only whole records (the cut first line is dropped)");

// ── G. same id on two devices -> newest wins, and says so ──────────────────
const dup = await resume(DUP_ID);
check(dup.includes("2 devices hold this id") && dup.includes("localhost"),
  `an id held by two devices resumes the newest and names it — got: ${JSON.stringify(dup.slice(0, 200))}`);

// ── H. non-regression: the telegram path still resumes ─────────────────────
const tg = await resume(TG_ID);
const tgHistory = route.getState(CHAT, "claude").history;
check(tg.startsWith("▶️") && tgHistory.some((m) => m.content === "telegram turn one"),
  `/resume <telegram-id> still works exactly as before — got: ${JSON.stringify(tg.slice(0, 200))}`);

// ── I. an unknown id is an honest miss, not a 404 stack ────────────────────
const miss = await resume("no-such-session-id");
check(miss.includes("no session") && miss.includes("no-such-session-id"),
  `an unknown id answers plainly — got: ${JSON.stringify(miss.slice(0, 160))}`);

console.log("── tester summary ──");
if (failures.length > 0) {
  console.error(`RED: ${failures.length} check(s) FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("GREEN: all #513 cross-device /resume checks pass");
process.exit(0);
