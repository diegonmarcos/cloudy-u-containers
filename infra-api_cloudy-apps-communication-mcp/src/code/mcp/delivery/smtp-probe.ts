// RCPT TO mailbox probe (#1803). Runs from the server only, and NEVER sends DATA:
// the command sequence is fixed to  EHLO -> MAIL FROM -> RCPT TO <addr> ->
// RCPT TO <random@domain> (catch-all detection) -> RSET -> QUIT.
// There is no code path that writes "DATA"; probe.test.ts asserts the transcript.
//
// The transport is injected (`connect`) so tests replay recorded SMTP transcripts
// and CI never opens a socket.

import { connect as netConnect } from "node:net";
import { randomBytes } from "node:crypto";

export interface Line { code: number; text: string }

/** Minimal line-oriented duplex: what a TCP socket gives the probe. */
export interface ProbeConn {
  /** Next complete SMTP reply (multi-line replies joined). Rejects on timeout/close. */
  reply(): Promise<Line>;
  send(line: string): void;
  close(): void;
}
export type Connector = (host: string, port: number, timeoutMs: number) => Promise<ProbeConn>;

export interface ProbeResult {
  host: string;
  connected: boolean;
  /** EHLO SIZE in bytes; 0 = advertised without a limit; null = not advertised / not reached. */
  sizeLimit: number | null;
  mailbox: "exists" | "does_not_exist" | "accepts_all" | "unknown";
  code: number | null;
  reason: string;
  transcript: string[];
}

export function tcpConnector(): Connector {
  return (host, port, timeoutMs) => new Promise((resolve, reject) => {
    const sock = netConnect({ host, port });
    let buf = "";
    const waiters: Array<{ res: (l: Line) => void; rej: (e: Error) => void }> = [];
    const ready: Line[] = [];
    let dead: Error | null = null;
    let pending: string[] = [];
    const flush = () => {
      while (ready.length && waiters.length) (waiters.shift() as { res: (l: Line) => void }).res(ready.shift() as Line);
      if (dead) while (waiters.length) (waiters.shift() as { rej: (e: Error) => void }).rej(dead);
    };
    sock.setTimeout(timeoutMs, () => { dead = new Error(`timeout after ${timeoutMs}ms`); sock.destroy(); flush(); });
    sock.on("error", (e) => { dead = e; flush(); reject(e); });
    sock.on("close", () => { dead = dead ?? new Error("connection closed"); flush(); });
    sock.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        pending.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
          ready.push({ code: parseInt(line.slice(0, 3), 10), text: pending.join("\n") });
          pending = [];
        }
      }
      flush();
    });
    sock.on("connect", () => resolve({
      reply: () => new Promise<Line>((res, rej) => { waiters.push({ res, rej }); flush(); }),
      send: (l: string) => { if (/^\s*DATA\b/i.test(l)) throw new Error("probe must never send DATA"); sock.write(l + "\r\n"); },
      close: () => sock.destroy(),
    }));
  });
}

export function parseSize(ehlo: string): number | null {
  for (const raw of ehlo.split("\n")) {
    const l = raw.replace(/^\d{3}[- ]/, "").trim();
    const m = l.match(/^SIZE(?:\s+(\d+))?\s*$/i);
    if (m) return m[1] ? parseInt(m[1], 10) : 0;
  }
  return null;
}

export interface ProbeOptions {
  helo: string;
  mailFrom: string;           // "" = null reverse-path <>
  timeoutMs: number;
  port: number;
  random?: () => string;      // catch-all probe local part (tests pin it)
}

export async function probeMailbox(connector: Connector, host: string, address: string, opt: ProbeOptions): Promise<ProbeResult> {
  const transcript: string[] = [];
  const result: ProbeResult = { host, connected: false, sizeLimit: null, mailbox: "unknown", code: null, reason: "", transcript };
  let conn: ProbeConn;
  try {
    conn = await connector(host, opt.port, opt.timeoutMs);
  } catch (e) {
    result.reason = `cannot reach ${host}:${opt.port} from the server (${(e as Error).message})`;
    return result;
  }
  result.connected = true;
  const say = (l: string) => { transcript.push(`C: ${l}`); conn.send(l); };
  const hear = async () => { const r = await conn.reply(); transcript.push(`S: ${r.text}`); return r; };
  try {
    const greet = await hear();
    if (greet.code !== 220) { result.reason = `greeting ${greet.text}`; return result; }
    say(`EHLO ${opt.helo}`);
    const ehlo = await hear();
    if (ehlo.code !== 250) { result.reason = `EHLO refused: ${ehlo.text}`; return result; }
    result.sizeLimit = parseSize(ehlo.text);
    say(`MAIL FROM:<${opt.mailFrom}>`);
    const mf = await hear();
    if (mf.code !== 250) { result.reason = `MAIL FROM refused (${mf.text}); mailbox not tested`; return result; }
    say(`RCPT TO:<${address}>`);
    const rc = await hear();
    result.code = rc.code;
    if (rc.code === 250 || rc.code === 251) {
      const domain = address.slice(address.lastIndexOf("@") + 1);
      const rnd = (opt.random ?? (() => "probe-" + randomBytes(8).toString("hex")))();
      say(`RCPT TO:<${rnd}@${domain}>`);
      const rr = await hear();
      if (rr.code === 250 || rr.code === 251) { result.mailbox = "accepts_all"; result.reason = `${host} accepts any address at ${domain} (catch-all), so ${rc.code} proves nothing`; }
      else if (rr.code >= 500) { result.mailbox = "exists"; result.reason = `${host}: ${rc.text}`; }
      else { result.mailbox = "unknown"; result.reason = `${host} accepted the address but deferred the control address (${rr.text}); cannot rule out catch-all`; }
    } else if (rc.code >= 400 && rc.code < 500) {
      result.mailbox = "unknown";
      result.reason = `${host} deferred RCPT (${rc.text}) — greylisting or rate limit, not a verdict`;
    } else if ([550, 551, 553].includes(rc.code) && !/\b5\.7\.\d+\b/.test(rc.text)) {
      result.mailbox = "does_not_exist";
      result.reason = `${host}: ${rc.text}`;
    } else {
      result.mailbox = "unknown";
      result.reason = `${host} refused RCPT for a policy reason (${rc.text}), not a mailbox verdict`;
    }
    return result;
  } catch (e) {
    result.reason = `probe to ${host} aborted: ${(e as Error).message}`;
    return result;
  } finally {
    try { say("RSET"); await hear().catch(() => undefined); say("QUIT"); await hear().catch(() => undefined); } catch { /* closing */ }
    conn.close();
  }
}
