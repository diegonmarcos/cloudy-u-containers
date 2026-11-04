// Tester: ticket #545 — the silent no-reply. The bot looked alive (logged
// "handled"), did nothing, and the user never saw a reply. This tester pins
// the anti-silence contract: a delivery that Telegram would not accept must
// reach the user as a visible notice, never as silence, and the success log
// must be gated on actual delivery (a "handled"-style green that verified
// nothing is the defect this ticket removes).
//
// Two halves:
//   RUNTIME — exercise deliverChatReply (the exported delivery core in
//     bots/telegram.mjs) with a double send: an ok:false rejection and a
//     transport rejection must BOTH return delivered:false AND post a
//     "[gateway: delivery failed]" notice to the chat; an empty reply must
//     still produce the "[gateway: empty reply]" fallback; a message over the
//     4096 cap must be split.
//   STATIC — the handler's success console.log must sit inside an
//     `if (delivered)` branch (never an unconditional handled log after a send
//     that may not have happened), and a handler error must reach the chat as
//     "[gateway: error]" rather than a swallowed catch.
//
// Regenerate dist from src and commit BOTH when this file changes (see
// test-my-ai-src-dist-parity.mjs). Usage: node test-my-ai-gateway-fail-loud.mjs
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deliverChatReply, TELEGRAM_MAX_MESSAGE } from "./bots/telegram.mjs";

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  <- ${detail}`}`);
  if (!ok) failures++;
};

// A scriptable Telegram stand-in: records every sendMessage it is asked to
// make and returns a configurable result per call (ok:true, ok:false, or a
// transport RejectionError).
const calls = [];
const makeSend = (results) => async (_method, body) => {
  calls.push(body);
  const r = results[Math.min(calls.length - 1, results.length - 1)];
  if (r instanceof Error) throw r;
  return r;
};

// ── RUNTIME: the delivery core ───────────────────────────────────────────────
{
  calls.length = 0;
  const doSend = makeSend([{ ok: true, result: {} }]);
  const res = await deliverChatReply({ doSend, chat_id: 1, text: "hello" });
  check("runtime delivered:true on accepted send", res.delivered === true, String(res.delivered));
  check("runtime accepted send posted no failure notice", !calls.some((c) => String(c.text || "").includes("[gateway: delivery failed]")), "a notice was posted for an accepted send");
}

{
  // ok:false rejection — a failing model/upstream that Telegram refuses to
  // accept must produce a message in the chat, not silence.
  calls.length = 0;
  const doSend = makeSend([{ ok: false, error_code: 400, description: "Bad Request" }]);
  const res = await deliverChatReply({ doSend, chat_id: 1, text: "boom" });
  check("runtime delivered:false on ok:false send", res.delivered === false, "delivered must be false");
  const notice = calls.find((c) => String(c.text || "").includes("[gateway: delivery failed]"));
  check("runtime ok:false failure posts a visible failure notice", !!notice, "no '[gateway: delivery failed]' notice in chat");
  check("runtime ok:false notice says the reason", !!notice && /Bad Request/.test(notice.text), "notice omits the failure reason");
}

{
  // Transport rejection (network error) — the other half of "the user did not
  // receive it"; must drive the same delivered:false + notice path, never an
  // uncaught throw that leaves the caller thinking the send is pending.
  calls.length = 0;
  const doSend = makeSend([new Error("ECONNRESET")]);
  const res = await deliverChatReply({ doSend, chat_id: 1, text: "boom" });
  check("runtime delivered:false on transport rejection", res.delivered === false, "delivered must be false");
  const notice = calls.find((c) => String(c.text || "").includes("[gateway: delivery failed]"));
  check("runtime transport failure posts a visible failure notice", !!notice, "no '[gateway: delivery failed]' notice in chat");
}

{
  // Empty model reply — must still reach the user as the explicit fallback,
  // never vanish, and must still count as delivered (an empty reply IS a
  // delivered reply to the user).
  calls.length = 0;
  const doSend = makeSend([{ ok: true, result: {} }]);
  const res = await deliverChatReply({ doSend, chat_id: 1, text: "" });
  check("runtime empty reply sends the '[gateway: empty reply]' fallback", calls.some((c) => c.text === "[gateway: empty reply]"), "no fallback chunk sent");
  check("runtime empty reply still returns delivered:true", res.delivered === true, "empty reply rejected as undelivered");
}

{
  // Long reply — Telegram caps a single message at 4096 chars; the reply must
  // be split into ordered chunks, all delivered.
  calls.length = 0;
  const long = "x".repeat(TELEGRAM_MAX_MESSAGE + 10);
  const doSend = makeSend([{ ok: true, result: {} }, { ok: true, result: {} }]);
  const res = await deliverChatReply({ doSend, chat_id: 1, text: long });
  check("runtime >4096 reply split into multiple chunks", calls.length === 2, `expected 2 chunks, got ${calls.length}`);
  check("runtime chunks reassemble to the original text", calls.map((c) => c.text).join("") === long, "chunks did not reassemble");
  check("runtime long-split returned delivered:true", res.delivered === true, "long reply not marked delivered");
}

// ── STATIC: the poll-loop success log and the handler error path ─────────────
{
  const tg = readFileSync(join(process.cwd(), "bots/telegram.mjs"), "utf8");
  // The success marker may only fire after real delivery — it must be gated on
  // the delivered flag, and the old unconditional "handled" log (a green that
  // verified nothing) must be gone.
  check("static success log is gated on `if (delivered)`", /if \(delivered\) \{/.test(tg), "no `if (delivered) {` gate in telegram.mjs");
  check("static no unconditional 'handled' success log remains", !/console\.log\([^)]*handled/.test(tg), "an unconditional 'handled' success log remains");
  // A handler error must reach the user in the chat, not be swallowed.
  check("static handler error posts '[gateway: error]' to the chat", tg.includes("[gateway: error]"), "no error notice to the user in the handler catch");
  // The two halves of the fix must be wired into the poll loop: the send is
  // awaited, its delivered flag drives the log, and a non-delivery has its own
  // honest log line.
  check("static poll loop awaits delivery and branches on delivered", /const \{ delivered \} = await sendMessage/.test(tg) && tg.includes("reply NOT delivered"), "send result not honored in the poll loop");
}

console.log(failures === 0 ? "ALL GREEN" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
