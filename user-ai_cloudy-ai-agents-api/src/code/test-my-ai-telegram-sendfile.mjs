// Tester: ticket #559 — the bots could talk about a file but never hand one
// over. Every send in this gateway went through tgPost (application/json) and
// Telegram's sendDocument accepts multipart/form-data ONLY, so there was no
// code path at all from "I produced a report" to "you received it".
//
// Two halves, and BOTH are needed:
//
//   BEHAVIOUR — deliverDocument is exercised directly through its injected
//   transport (same contract as deliverChatReply's doSend), so the size cap,
//   the thread retry and the never-silent failure path are proven without a
//   network.
//
//   TRANSPORT — an injected fake would pass even if the real sender still
//   posted JSON, which is exactly the vacuous-green shape this fleet keeps
//   finding. So the source itself is asserted: sendDocument must be built with
//   FormData and must NOT be routed through tgPost.
//
// Usage: node test-my-ai-telegram-sendfile.mjs   (cwd = <repo>/user-ai_my-ai-api/src/code)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deliverDocument, TELEGRAM_MAX_DOCUMENT_BYTES } from "./bots/telegram.mjs";
import { COMMANDS } from "./bots/commands.mjs";

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const here = process.cwd();
const telegramSrc = readFileSync(join(here, "bots/telegram.mjs"), "utf8");

// ── B: behaviour of the delivery core ───────────────────────────────────────

// B1 happy path: the upload is called once, with the bytes and the filename.
{
  const calls = [];
  const res = await deliverDocument({
    doUpload: async (method, fields) => { calls.push({ method, fields }); return { ok: true }; },
    chat_id: 42,
    filename: "P-Backlog.html",
    bytes: Buffer.from("<html>hi</html>"),
  });
  check("B1 delivered:true on an accepted upload", res.delivered === true, JSON.stringify(res));
  check("B1 calls sendDocument exactly once", calls.length === 1 && calls[0].method === "sendDocument",
    JSON.stringify(calls.map((c) => c.method)));
  check("B1 carries the filename through", calls[0]?.fields?.filename === "P-Backlog.html",
    JSON.stringify(calls[0]?.fields?.filename));
  check("B1 carries the real bytes", String(calls[0]?.fields?.bytes) === "<html>hi</html>");
}

// B2 an empty file is refused BEFORE a round trip — an empty upload is
// accepted by nothing and explains nothing.
{
  const calls = [];
  const res = await deliverDocument({
    doUpload: async (...a) => { calls.push(a); return { ok: true }; },
    chat_id: 1, filename: "empty.txt", bytes: Buffer.alloc(0),
  });
  check("B2 empty file → delivered:false", res.delivered === false, JSON.stringify(res));
  check("B2 empty file spends no round trip", calls.length === 0, `calls=${calls.length}`);
  check("B2 empty file gives a reason", typeof res.reason === "string" && res.reason.length > 0, JSON.stringify(res));
}

// B3 oversize is refused locally, with the limit named. maxBytes is injected
// so this stays a millisecond test rather than allocating 50 MB.
{
  const calls = [];
  const res = await deliverDocument({
    doUpload: async (...a) => { calls.push(a); return { ok: true }; },
    chat_id: 1, filename: "big.bin", bytes: Buffer.alloc(11), maxBytes: 10,
  });
  check("B3 oversize → delivered:false", res.delivered === false, JSON.stringify(res));
  check("B3 oversize spends no round trip", calls.length === 0, `calls=${calls.length}`);
  check("B3 oversize reason names the file", /big\.bin/.test(res.reason || ""), res.reason);
}
check("B3 the real cap is Telegram's documented 50 MB",
  TELEGRAM_MAX_DOCUMENT_BYTES === 50 * 1024 * 1024, String(TELEGRAM_MAX_DOCUMENT_BYTES));

// B4 the thread trap: a stale message_thread_id makes Telegram reject the whole
// send, so a threaded failure must be retried unthreaded rather than lost.
{
  const threads = [];
  const res = await deliverDocument({
    doUpload: async (_m, f) => {
      threads.push(f.message_thread_id);
      return f.message_thread_id !== undefined
        ? { ok: false, description: "message thread not found" }
        : { ok: true };
    },
    chat_id: 7, filename: "a.txt", bytes: Buffer.from("x"), message_thread_id: 99,
  });
  check("B4 threaded failure retries unthreaded", threads.length === 2 && threads[0] === 99 && threads[1] === undefined,
    JSON.stringify(threads));
  check("B4 the retry's success is the verdict", res.delivered === true, JSON.stringify(res));
}

// B5 a hard failure must NEVER be silent: delivered:false AND a reason the
// caller can put in front of the user.
{
  const res = await deliverDocument({
    doUpload: async () => ({ ok: false, description: "Bad Request: chat not found" }),
    chat_id: 3, filename: "a.txt", bytes: Buffer.from("x"),
  });
  check("B5 rejected upload → delivered:false", res.delivered === false, JSON.stringify(res));
  check("B5 the Telegram description is surfaced verbatim",
    res.reason === "Bad Request: chat not found", JSON.stringify(res.reason));
}

// B6 a THROWN transport error is the same "the user did not receive it" fact
// as an ok:false — it must not escape as an uncaught rejection that leaves the
// caller believing the send is pending.
{
  let threw = false;
  let res = null;
  try {
    res = await deliverDocument({
      doUpload: async () => { throw new Error("ECONNRESET"); },
      chat_id: 3, filename: "a.txt", bytes: Buffer.from("x"),
    });
  } catch { threw = true; }
  check("B6 a thrown transport error does not propagate", threw === false);
  check("B6 a thrown transport error → delivered:false with the reason",
    res?.delivered === false && /ECONNRESET/.test(res?.reason || ""), JSON.stringify(res));
}

// ── T: the REAL transport, not the injected fake ────────────────────────────
// Without these, every B-check above would still pass if the shipped sender
// posted JSON — the assertion would hold whether or not the code under test
// was correct.

check("T1 the real uploader builds multipart with FormData",
  /new FormData\(\)/.test(telegramSrc), "no FormData in bots/telegram.mjs");

check("T2 the document part carries an explicit filename (else Telegram names it \"blob\")",
  /form\.set\(\s*["']document["']\s*,\s*new Blob\(\[[^\]]*\]\)\s*,\s*filename\s*\)/.test(telegramSrc),
  "document part is missing the filename argument");

check("T3 sendDocument is NOT routed through the JSON tgPost",
  !/tgPost\(\s*["']sendDocument["']/.test(telegramSrc),
  "sendDocument is being posted as JSON — Telegram rejects that");

// Setting Content-Type by hand breaks the multipart boundary fetch generated —
// the request then describes a body it did not produce and Telegram rejects
// it. Assert on the `headers` KEY, not on the string "content-type": the
// latter also appears in the comment explaining this very trap, so matching it
// would make this check pass or fail on prose rather than on code.
{
  const start = telegramSrc.indexOf("const tgUpload");
  const uploadBlock = telegramSrc.slice(start, telegramSrc.indexOf("// message_thread_id threads"));
  check("T4 the upload passes no headers option (fetch must own the boundary)",
    start !== -1 && uploadBlock.length > 0 && !/\bheaders\s*:/.test(uploadBlock),
    "tgUpload passes a headers option to fetch");
}

// ── C: the command is reachable ─────────────────────────────────────────────
// Telegram only offers a command in its menu if setMyCommands was told about
// it, and setMyCommands is fed from COMMANDS.
check("C1 /sendfile is registered in COMMANDS",
  COMMANDS.some((c) => c.command === "sendfile"),
  JSON.stringify(COMMANDS.map((c) => c.command)));
check("C2 /sendfile is handled in the poll loop",
  /cmd === "sendfile"/.test(telegramSrc), "no sendfile branch in bots/telegram.mjs");
check("C3 a failed /sendfile still answers in the chat",
  /gateway: file not sent/.test(telegramSrc), "no failure sentence on the /sendfile path");

console.log(`\n${pass} PASS, ${fail} FAIL`);
if (fail > 0) { console.error("NOT GREEN"); process.exit(1); }
console.log("ALL GREEN");
