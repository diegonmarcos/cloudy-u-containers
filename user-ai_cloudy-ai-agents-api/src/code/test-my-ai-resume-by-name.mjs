// Tester: ticket #525 — `/resume` takes the NAME, not the UUID, for every
// agent. The listing shows a name per session (#516, deriveSessionName in
// sessions-store.mjs, served by server.mjs's /sessions); THIS tester proves the
// name is the ADDRESS: /resume <name> restores the right session, two sessions
// sharing a name are surfaced instead of guessed between, a session that spans
// devices (or #506-rolled files) is ONE target, and the name is never declared
// in a second place next to the one derivation.
//
// Like test-my-ai-resume-session-names.mjs, it drives the REAL server.mjs
// endpoint and the REAL commands.mjs handler — the name must come from the one
// place the tickets keep pointing at, so the tester asserts the thing that
// place actually returns. Runs on every push via .github/workflows/
// per-service-tests.yml (registered in build.json tests.resume-by-name,
// cwd=src/code). Self-contained: fixture store only, no real sessions needed.
//
// Mutation-proven locally (see ticket report for pasted runs):
//   * resolve name->id only again (revert #525)      -> checks 1-4 RED
//   * silently pick the first of two same-name ids   -> check 5 RED
//   * serve the UUID as the name (second declaration)-> checks 12 RED
//   * drop the served `name` field, bot re-derives   -> checks 13 RED
//   * green on the tree at HEAD after the fix        -> all GREEN
//
// Usage: node test-my-ai-resume-by-name.mjs   (exit 0 = PASS)
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "myai-by-name-525-"));
process.env.BRIDGE_SESSIONS_DIR = TMP;
process.env.BRIDGE_RESUME_MAX_MESSAGES = "20";
process.env.BRIDGE_RESUME_MAX_BYTES = "1000000";
process.env.BRIDGE_RESUME_MAX_LISTED = "40";
process.env.BRIDGE_NAME_HEAD_BYTES = "8192";
process.env.BRIDGE_NAME_TAIL_BYTES = "4096";
process.env.BRIDGE_PORT = "13927";
process.env.BRIDGE_BIND = "127.0.0.1";
process.env.BRIDGE_OLLAMA_PORT = "13928";
process.env.MCP_ENABLED = "0";
process.env.MYAI_LOCAL_URL = "http://127.0.0.1:13927";

const store = await import(new URL("./sessions-store.mjs", import.meta.url).href);
const failures = [];
const ok = (l) => console.log(`  OK: ${l}`);
const bad = (l) => { failures.push(l); console.log(`FAIL: ${l}`); };
const check = (cond, label) => (cond ? ok(label) : bad(label));

// ── fixture store ───────────────────────────────────────────────────────────
const ID_TITLED = "00000000-0000-0000-0000-000000000001";
const ID_PROMPT = "00000000-0000-0000-0000-000000000002";
const ID_FLAT = "00000000-0000-0000-0000-000000000003";
const ID_STUB1 = "00000000-0000-0000-0000-000000000004";
const ID_STUB2 = "00000000-0000-0000-0000-000000000005";
const ID_DUP1 = "00000000-0000-0000-0000-000000000006";
const ID_DUP2 = "00000000-0000-0000-0000-000000000007";
const ID_BOTH_DEVICES = "00000000-0000-0000-0000-000000000008";
const ID_LONG = "00000000-0000-0000-0000-000000000009";
const LONG_PROMPT = "the quick brown fox jumps over the lazy dog while a dozen sleepy sentinels keep watch over the silent citadel of appledore at midnight";

const writeAs = (device, id, body, mtimeMs) => {
  const d = join(TMP, device);
  mkdirSync(d, { recursive: true });
  const f = join(d, `${id}.jsonl`);
  writeFileSync(f, `${body}\n`);
  if (mtimeMs) utimesSync(f, new Date(mtimeMs), new Date(mtimeMs));
  return f;
};

writeAs("localhost", ID_TITLED, [
  `{"type":"custom-title","customTitle":"cloud-mail","sessionId":"${ID_TITLED}"}`,
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"sort the mail rules"}]}}`,
  `{"type":"last-prompt","lastPrompt":"sort the mail rules","sessionId":"${ID_TITLED}"}`,
].join("\n"), 1789900000);

writeAs("localhost", ID_PROMPT, [
  `{"type":"last-prompt","leafUuid":"93f99602-d4a2-44db-898e-278eb2fca95e"}`,
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<local-command-caveat>Caveat: injected.</local-command-caveat>"}]}}`,
  `{"type":"last-prompt","lastPrompt":"check why sshd alias not working","sessionId":"${ID_PROMPT}"}`,
].join("\n"), 1789901000);

writeAs("telegram", ID_FLAT, store.serializeHistory([
  { role: "user", content: "add the namee!!!!!!" },
  { role: "assistant", content: "on it" },
]), 1789902000);

writeAs("localhost", ID_STUB1, `{"type":"bridge-session","sessionId":"${ID_STUB1}","lastSequenceNum":0}`, 1789903000);
writeAs("surface-nixos", ID_STUB2, `{"type":"bridge-session","sessionId":"${ID_STUB2}","lastSequenceNum":0}`, 1789904000);

writeAs("localhost", ID_DUP1, [
  `{"type":"custom-title","customTitle":"duplicate","sessionId":"${ID_DUP1}"}`,
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"first duplicate session"}]}}`,
].join("\n"), 1789905000);
writeAs("surface-nixos", ID_DUP2, [
  `{"type":"custom-title","customTitle":"duplicate","sessionId":"${ID_DUP2}"}`,
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"second duplicate session"}]}}`,
].join("\n"), 1789906000);

// SAME session id on two devices: one target, newest file wins (#506-style roll
// over / cross-device sync — the name addresses the SESSION, not the file).
writeAs("localhost", ID_BOTH_DEVICES, [
  `{"type":"custom-title","customTitle":"same-session","sessionId":"${ID_BOTH_DEVICES}"}`,
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"older copy"}]}}`,
].join("\n"), 1789907000);
writeAs("surface-nixos", ID_BOTH_DEVICES, [
  `{"type":"custom-title","customTitle":"same-session","sessionId":"${ID_BOTH_DEVICES}"}`,
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"newer copy"}]}}`,
].join("\n"), 1789908000);

writeAs("localhost", ID_LONG, [
  `{"type":"last-prompt","lastPrompt":"${LONG_PROMPT}"}`,
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"go"}]}}`,
].join("\n"), 1789909000);

// ── the REAL server, serving the REAL one declaration ───────────────────────
await import(new URL("./server.mjs", import.meta.url).href);
const listing = await fetch("http://127.0.0.1:13927/sessions").then((r) => r.json());
const byId = Object.fromEntries(listing.map((s) => [s.id, s]));
check(listing.length === 10, `fixture store lists 10 files (one of them the same id on two devices) — got ${listing.length}`);

const cmds = await import(new URL("./bots/commands.mjs", import.meta.url).href);
const route = await import(new URL("./bots/route.mjs", import.meta.url).href);
const CHAT = "telegram-claude:525";
const meta = { fromId: "0", allowFrom: ["0"] };
const resume = (a) => cmds.handleCommand("resume", a, CHAT, meta, "claude");
const historyOf = () => route.getState(CHAT, "claude").history;

// ── 1. the NAME is the address: a titled session resumes by its name ────────
const r1 = await resume("cloud-mail");
check(r1.startsWith("▶️") && route.getState(CHAT, "claude").history.length > 0,
  `/resume cloud-mail resumes the titled session — got: ${JSON.stringify(r1.slice(0, 120))}`);
check(r1.includes("cloud-mail"), "/resume's reply names the session it resumed");

// ── 2. a last-prompt-named session resumes by its name ──────────────────────
const r2 = await resume("check why sshd alias not working");
check(r2.startsWith("▶️") && historyOf().some((m) => m.role === "user" && m.content.includes("local-command-caveat")),
  `/resume <last-prompt name> resumes THAT session, not a guess — got: ${JSON.stringify(r2.slice(0, 120))}`);

// ── 3. the bot's own flat NDJSON session is addressed by its derived name ───
const r3 = await resume("add the namee!!!!!!");
check(r3.startsWith("▶️") && route.getState(CHAT, "claude").history.some((m) => m.content === "add the namee!!!!!!"),
  `/resume <first-message name> resumes the telegram flat-NDJSON session — got: ${JSON.stringify(r3.slice(0, 120))}`);

// ── 4. a truncated long name is reachable by a UNIQUE prefix ────────────────
const r4 = await resume("the quick brown fox");
check(r4.startsWith("▶️") && historyOf().some((m) => m.content === "go"),
  `a long truncated name is addressable by a unique prefix — got: ${JSON.stringify(r4.slice(0, 120))}`);

// ── 5. two DIFFERENT sessions sharing a name are surfaced, never guessed ────
const r5 = await resume("duplicate");
check(!r5.startsWith("▶️") && !r5.includes("resumed"),
  `two sessions named "duplicate" are NOT silently picked between — got: ${JSON.stringify(r5.slice(0, 180))}`);
check(r5.includes(ID_DUP1) && r5.includes(ID_DUP2),
  `...the ambiguity reply lists BOTH candidates with their ids (${ID_DUP1}, ${ID_DUP2}) — got: ${JSON.stringify(r5.slice(0, 240))}`);

// ── 6. a non-unique PREFIX is ambiguous too ─────────────────────────────────
const r6 = await resume("dup");
check(!r6.startsWith("▶️") && r6.includes(ID_DUP1) && r6.includes(ID_DUP2),
  `a prefix shared by two sessions surfaces both — got: ${JSON.stringify(r6.slice(0, 200))}`);

// ── 7. same id on two devices is ONE session: newest file wins, and says so ─
const r7 = await resume("same-session");
check(r7.startsWith("▶️") && historyOf().some((m) => m.content === "newer copy"),
  `a session held by two devices resumes the NEWEST copy by its name — got: ${JSON.stringify(r7.slice(0, 160))}`);
check(r7.includes("2 devices hold this session"), "the newest-file-wins note is stated — got: " + JSON.stringify(r7.slice(0, 200)));

// ── 8. an unnamed session must NOT be a blind address ───────────────────────
// Two stub sessions both derive "(unnamed)". Resuming by that name must fail
// with a choice, not silently pick one — "an unnamed session must fail, not
// silently print a bare UUID".
const r8 = await resume("(unnamed)");
check(!r8.startsWith("▶️") && r8.includes(ID_STUB1) && r8.includes(ID_STUB2),
  `two "(unnamed)" sessions are a choice, not a guess — got: ${JSON.stringify(r8.slice(0, 200))}`);

// ── 9. the id remains the TIEBREAKER (the disambiguator, not the address) ──
const r9 = await resume(ID_DUP1);
check(r9.startsWith("▶️") && historyOf().some((m) => m.content === "first duplicate session"),
  `the id still settles an ambiguous name — got: ${JSON.stringify(r9.slice(0, 160))}`);

// ── 10. an unknown name is an honest miss ───────────────────────────────────
const r10 = await resume("no such session anywhere");
check(r10.includes("no session") && !r10.startsWith("▶️"),
  `an unknown name answers plainly — got: ${JSON.stringify(r10.slice(0, 160))}`);

// ── 11. the listing advertises the NAME as the address ──────────────────────
const r11 = await resume("");
check(r11.includes("use /resume <name>"), `the no-arg hint points at the name — got: ${JSON.stringify(r11.slice(-60))}`);
check(r11.includes("cloud-mail") && r11.includes("add the namee!!!!!!"),
  "the no-arg listing still shows the names");

// ── 12. ONE declaration: the served name IS what deriveSessionName derives ──
// RED if server.mjs ever names a session a second way (e.g. by echoing its
// UUID), which is exactly the "second private copy of session identity" the
// ticket forbids. Also covered by the #516 tester's "no row uses its own UUID
// as its name"; this points at the derivation directly.
const derivationsMatch = listing.every((row) => {
  const file = join(TMP, row.device, `${row.id}.jsonl`);
  return existsSync(file) && store.deriveSessionName(file).name === row.name;
});
check(derivationsMatch, `every one of the ${listing.length} served names is the ONE derivation — no second namer in server.mjs`);

// ── 13. the bot resolves the SERVED name; a name-less listing cannot resume ─
// RED if commands.mjs ever derives names itself (a second reader next to a call
// site — the exact #513 defect pattern): with no `name` on the rows the bot has
// nothing to match, so /resume <name> MUST miss on a name-less listing.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("/sessions")) {
    const out = [];
    for (const device of readdirSync(TMP)) {
      const ddir = join(TMP, device);
      if (!statSync(ddir).isDirectory()) continue;
      for (const f of readdirSync(ddir)) {
        if (!f.endsWith(".jsonl")) continue;
        const st = statSync(join(ddir, f));
        // Deliberately NO name field — the mutation a second declaration would
        // survive.
        out.push({ device, id: f.slice(0, -6), mtime: st.mtimeMs, size: st.size });
      }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(out), json: async () => out };
  }
  throw new Error(`unexpected fetch in name-less listing: ${u}`);
};
const r13 = await resume("cloud-mail");
globalThis.fetch = nativeFetch;
check(r13.includes("no session") && !r13.startsWith("▶️"),
  `with the served name removed, /resume <name> cannot resolve — the bot does not hold a second copy — got: ${JSON.stringify(r13.slice(0, 140))}`);
const listingNoName = await fetch("http://127.0.0.1:13927/sessions").then((r) => r.json());
check(listingNoName.length === 10, "native fetch restored after the name-less stub");

// ── 14. resolver unit contract: matchedBy and edge cases ────────────────────
const addrLong = store.resolveResumeAddress(listing, "THE QUICK BROWN FOX");
check(addrLong.ok && addrLong.matchedBy === "prefix",
  `case is folded for the match — got matchedBy=${addrLong?.matchedBy}`);
const addrId = store.resolveResumeAddress(listing, ID_FLAT);
check(addrId.ok && addrId.matchedBy === "id" && addrId.session.id === ID_FLAT,
  "an id-only address resolves through the id tiebreaker");
const addrEmpty = store.resolveResumeAddress(listing, "   ");
check(addrEmpty.ok === false && addrEmpty.miss, "a blank address is a miss, never a guess");
const addrAmb = store.resolveResumeAddress(listing, "(unnamed)");
check(addrAmb.ok === false && addrAmb.ambiguous?.length === 2, "resolveResumeAddress reports ambiguity instead of picking");

// ── summary ────────────────────────────────────────────────────────────────
console.log("── tester summary ──");
if (failures.length > 0) {
  console.error(`RED: ${failures.length} check(s) FAILED:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log("GREEN: all #525 resume-by-name checks pass");
process.exit(0);