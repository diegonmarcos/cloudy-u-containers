// Wires the #1802/#1803 REST surface from the environment compose.nix sets
// (values declared in build.json#delivery_api).

import type { IncomingMessage, ServerResponse } from "node:http";
import { Ledger } from "./ledger.ts";
import { RecipientChecker } from "./recipients.ts";
import { tcpConnector } from "./smtp-probe.ts";
import { handleRest, type RestDeps } from "./rest.ts";
import { stalwartDirectory, systemMx, systemTxt } from "./adapters.ts";

const csv = (v: string | undefined, d: string) => (v ?? d).split(",").map((x) => x.trim()).filter(Boolean);

function overrides(spec: string): Record<string, { host: string; port: number }> {
  const out: Record<string, { host: string; port: number }> = {};
  for (const item of csv(spec, "")) {
    const m = item.match(/^([^=]+)=([^:]+):(\d+)$/);
    if (m) out[m[1].toLowerCase()] = { host: m[2], port: parseInt(m[3], 10) };
  }
  return out;
}

let deps: RestDeps | null = null;

export function deliveryDeps(): RestDeps {
  if (deps) return deps;
  const e = process.env;
  const ledger = new Ledger({
    path: e.DELIVERY_LEDGER_PATH ?? "/data/delivery-ledger.jsonl",
    relayHosts: csv(e.DELIVERY_RELAY_HOSTS, ""),
    localDomains: csv(e.DELIVERY_LOCAL_DOMAINS, "").map((d) => d.toLowerCase()),
    retentionDays: parseInt(e.DELIVERY_RETENTION_DAYS ?? "90", 10),
  });
  const checker = new RecipientChecker({
    helo: e.PROBE_HELO ?? "localhost",
    mailFrom: e.PROBE_MAIL_FROM ?? "",
    probePort: parseInt(e.PROBE_PORT ?? "25", 10),
    probeTimeoutMs: parseInt(e.PROBE_TIMEOUT_MS ?? "8000", 10),
    maxMxTried: 2,
    probeOverrides: overrides(e.PROBE_OVERRIDES ?? ""),
    cacheTtlMs: parseInt(e.RECIPIENT_CACHE_TTL_MS ?? String(6 * 3600_000), 10),
    cacheTtlUnknownMs: parseInt(e.RECIPIENT_CACHE_TTL_UNKNOWN_MS ?? String(15 * 60_000), 10),
    maxAddressesPerRequest: 50,
    rateLimit: { addresses: parseInt(e.RECIPIENT_RATE_LIMIT ?? "60", 10), perMs: 60_000 },
  }, systemMx(), tcpConnector(), ledger);
  deps = {
    ledger,
    directory: stalwartDirectory(),
    txt: systemTxt(),
    checker,
    ingestAllowed: csv(e.DELIVERY_INGEST_ALLOWED, "10.0.0.3,10.1.0.3"),
  };
  return deps;
}

export function handleDeliveryRest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  return handleRest(req, res, deliveryDeps());
}
