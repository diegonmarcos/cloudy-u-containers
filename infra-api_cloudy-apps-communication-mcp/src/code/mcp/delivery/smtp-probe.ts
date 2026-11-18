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
/** Opens a TCP session; MUST reject within `connectTimeoutMs` if the peer never answers. */
export type Connector = (host: string, port: number, connectTimeoutMs: number) => Promise<ProbeConn>;

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
  return (host, port, connectTimeoutMs) => new Promise((resolve, reject) => {
    const sock = netConnect({ host, port });
    // A dropped SYN (OCI/GCP drop outbound :25 silently) never errors on its own; before
    // this timer the promise stayed pending forever and so did the HTTP request.
    const connectTimer = setTimeout(() => {
      sock.destroy();
      reject(Object.assign(new Error(`connect timeout after ${connectTimeoutMs}ms`), { code: "ETIMEDOUT" }));
    }, connectTimeoutMs);
    let buf = "";
    const waiters: Array<{ res: (l: Line) => void; rej: (e: Error) => void }> = [];
    const ready: Line[] = [];
    let dead: Error | null = null;
    let pending: string[] = [];
    const flush = () => {
      while (ready.length && waiters.length) (waiters.shift() as { res: (l: Line) => void }).res(ready.shift() as Line);
      if (dead) while (waiters.length) (waiters.shift() as { rej: (e: Error) => void }).rej(dead);
    };
    sock.setTimeout(connectTimeoutMs * 2, () => { dead = new Error("idle timeout"); sock.destroy(); flush(); });
    sock.on("error", (e) => { clearTimeout(connectTimer); dead = e; flush(); reject(e); });
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
    sock.on("connect", () => { clearTimeout(connectTimer); resolve({
      reply: () => new Promise<Line>((res, rej) => { waiters.push({ res, rej }); flush(); }),
      send: (l: string) => { if (/^\s*DATA\b/i.test(l)) throw new Error("probe must never send DATA"); sock.write(l + "\r\n"); },
      close: () => sock.destroy(),
    }); });
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_r, rej) => { t = setTimeout(() => rej(Object.assign(new Error(what), { code: "EBUDGET" })), Math.max(0, ms)); }),
  ]).finally(() => clearTimeout(t));
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
  connectTimeoutMs: number;   // TCP connect budget
  dialogueBudgetMs: number;   // whole SMTP dialogue after connect, greeting to last RCPT
  port: number;
  random?: () => string;      // catch-all probe local part (tests pin it)
}

export async function probeMailbox(connector: Connector, host: string, address: string, opt: ProbeOptions): Promise<ProbeResult> {
  const transcript: string[] = [];
  const result: ProbeResult = { host, connected: false, sizeLimit: null, mailbox: "unknown", code: null, reason: "", transcript };
  let conn: ProbeConn;
  try {
    // Raced as well: the budget holds even for a connector that ignores its timeout.
    conn = await withTimeout(connector(host, opt.port, opt.connectTimeoutMs), opt.connectTimeoutMs, `connect timeout after ${opt.connectTimeoutMs}ms`);
  } catch (e) {
    result.reason = `cannot reach ${host}:${opt.port} from the server (${(e as Error).message})`;
    return result;
  }
  result.connected = true;
  const say = (l: string) => { transcript.push(`C: ${l}`); conn.send(l); };
  const deadline = Date.now() + opt.dialogueBudgetMs;
  const hear = async () => {
    const r = await withTimeout(conn.reply(), deadline - Date.now(), `SMTP dialogue budget of ${opt.dialogueBudgetMs}ms exhausted`);
    transcript.push(`S: ${r.text}`);
    return r;
  };
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
    // Polite close without waiting on the peer: the answer is already decided.
    try { say("QUIT"); } catch { /* socket already gone */ }
    conn.close();
  }
}

/**
 * Is outbound TCP/25 usable from this host at all? Decided by one TCP connect to a
 * canary MX (no SMTP command is sent), cached for `ttlMs`; concurrent callers share
 * the in-flight attempt. OCI and GCP drop outbound :25, so on the fleet this is
 * normally "blocked" and remote mailbox probes are skipped instantly instead of
 * each burning a connect timeout.
 */
export class Port25Gate {
  private cached: { blocked: boolean; reason: string; at: number } | null = null;
  private inflight: Promise<{ blocked: boolean; reason: string; at: number }> | null = null;
  private readonly connector: Connector;
  private readonly canary: string;
  private readonly port: number;
  private readonly connectTimeoutMs: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(connector: Connector, canary: string, port: number, connectTimeoutMs: number, ttlMs: number, now: () => number = Date.now) {
    this.connector = connector; this.canary = canary; this.port = port;
    this.connectTimeoutMs = connectTimeoutMs; this.ttlMs = ttlMs; this.now = now;
  }
  async state(): Promise<{ blocked: boolean; reason: string; at: number }> {
    if (this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      let res: { blocked: boolean; reason: string; at: number };
      try {
        const c = await withTimeout(this.connector(this.canary, this.port, this.connectTimeoutMs), this.connectTimeoutMs, `connect timeout after ${this.connectTimeoutMs}ms`);
        c.close();
        res = { blocked: false, reason: `TCP connect to ${this.canary}:${this.port} succeeded`, at: this.now() };
      } catch (e) {
        res = { blocked: true, reason: `TCP connect to ${this.canary}:${this.port} failed: ${(e as Error).message}`, at: this.now() };
      }
      this.cached = res;
      this.inflight = null;
      return res;
    })();
    return this.inflight;
  }
}
