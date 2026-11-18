// Test doubles replaying the fixtures in ./fixtures (wire formats from Stalwart v0.16.5 source; SMTP/DNS transcripts) — no sockets, no live DNS.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Connector, ProbeConn } from "./smtp-probe.ts";
import type { MxResolver } from "./recipients.ts";
import type { TxtResolver } from "./sender-valid.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
export const fixture = (name: string): string => readFileSync(join(DIR, name), "utf8");
export const fixtureJson = (name: string): any => JSON.parse(fixture(name));

/** Replays the SMTP transcripts in smtp-sessions.json. Records every client line so tests can assert no DATA was sent. */
export function recordedConnector(sent: string[]): Connector {
  const sessions = fixtureJson("smtp-sessions.json");
  return async (host) => {
    const script = sessions[host];
    if (script === undefined) throw Object.assign(new Error(`connect ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    if (typeof script === "string") throw Object.assign(new Error(`connect ${script} ${host}:25`), { code: script });
    const replies = [...script];
    let firstRcpt: string | null = null;
    const conn: ProbeConn = {
      async reply() {
        if (!replies.length) throw new Error("connection closed");
        let r = replies.shift();
        if (r && typeof r === "object") r = firstRcpt === r.if_rcpt ? r.then : r.else;
        const text = String(r).replace(/\\n/g, "\n");
        return { code: parseInt(text.slice(0, 3), 10), text };
      },
      send(line) {
        if (/^\s*DATA\b/i.test(line)) throw new Error("probe sent DATA");
        sent.push(`${host}> ${line}`);
        const m = line.match(/^RCPT TO:<([^>]+)>/);
        if (m && firstRcpt === null) firstRcpt = m[1];
      },
      close() {},
    };
    return conn;
  };
}

export function recordedMx(): MxResolver {
  const d = fixtureJson("dns.json");
  return {
    async mx(domain) {
      if (d.nxdomain.includes(domain)) return null;
      if (!(domain in d.mx)) throw Object.assign(new Error(`queryMx ESERVFAIL ${domain}`), { code: "ESERVFAIL" });
      return d.mx[domain];
    },
    async a(domain) { return d.a[domain] ?? []; },
    async aaaa() { return []; },
  };
}

export function recordedTxt(): TxtResolver {
  const d = fixtureJson("dns.json");
  return { async txt(name) { return d.txt[name] ?? []; } };
}

/** x:<Type>/get answers shaped exactly as Stalwart v0.16.5 serialises them (stalwart-directory.json); a null type = unreadable. */
export function recordedRegistry(overrides: Record<string, any[] | null> = {}): (type: string) => Promise<any[]> {
  const reg = { ...fixtureJson("stalwart-directory.json"), ...overrides };
  return async (type) => {
    if (reg[type] === null) throw new Error(`x:${type}/get 503`);
    if (!(type in reg)) throw new Error(`x:${type}/get unknownMethod`);
    return reg[type];
  };
}
