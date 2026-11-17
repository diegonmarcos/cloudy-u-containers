// c3bot-relay reader for devops.telegram.* (#1579). Bot A (the c3-bot) is in WEBHOOK mode, so getUpdates on its token
// is refused by Telegram once the webhook is set; the inbound side (ask replies, chat and topic registry) therefore
// reads the relay's long-poll feed instead. Outbound sendMessage/sendDocument stay on Bot A, directly.
// Pure of module state except the feeder object; no Telegram token is involved here (only the relay bearer).

export interface RelayUpdate { update_id: number; message?: unknown; [k: string]: unknown }
interface RelayEvent { seq: number; type: string; update?: RelayUpdate }
interface PollReply { ok: boolean; cursor: number; head?: number; events: RelayEvent[] }

export function relayConfig(env: NodeJS.ProcessEnv): { base: string; token: string } | null {
  const token = (env.C3BOT_RELAY_TOKEN ?? "").trim();
  if (!token) return null;
  const base = (env.C3BOT_RELAY_URL ?? "http://c3bot-relay-http-3119.mesh.diegonmarcos.com").replace(/\/+$/, "");
  return { base, token };
}

export function createRelayFeeder(opts: {
  base: string;
  token: string;
  onUpdate: (u: RelayUpdate) => void;
  fetchImpl?: typeof fetch;
  waitSeconds?: number;
}) {
  const f = opts.fetchImpl ?? fetch;
  const wait = opts.waitSeconds ?? 25;
  let cursor = 0;
  // The relay's seq restarts at 1 when the relay restarts. Consumers order replies by update_id, so ids are
  // base + seq, and the base advances past everything already handed out when a reset is detected.
  let idBase = 0;
  let maxId = 0;
  return {
    get cursor() { return cursor; },
    async pollOnce(): Promise<number> {
      const r = await f(`${opts.base}/poll?after=${cursor}&wait=${wait}`, {
        headers: { authorization: `Bearer ${opts.token}` },
        signal: AbortSignal.timeout((wait + 10) * 1000),
      });
      if (!r.ok) throw new Error(`relay /poll HTTP ${r.status}`);
      const j = (await r.json()) as PollReply;
      if (typeof j.head === "number" && j.head < cursor) { idBase = maxId; cursor = 0; return 0; } // relay restarted
      let n = 0;
      for (const ev of j.events ?? []) {
        cursor = Math.max(cursor, ev.seq);
        if (!ev.update) continue;
        const id = idBase + ev.seq;
        maxId = Math.max(maxId, id);
        opts.onUpdate({ ...ev.update, update_id: id });
        n++;
      }
      if (typeof j.cursor === "number") cursor = Math.max(cursor, j.cursor);
      return n;
    },
  };
}
