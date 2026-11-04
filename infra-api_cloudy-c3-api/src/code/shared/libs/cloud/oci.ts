import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exec } from "../exec.js";
import type { z } from "zod";
import type { CloudInstanceSchema, CloudResourceSchema, CloudCostSchema } from "../schemas.js";

type CloudInstance = z.infer<typeof CloudInstanceSchema>;
type CloudResource = z.infer<typeof CloudResourceSchema>;
type CloudCost = z.infer<typeof CloudCostSchema>;

// Suppress file permissions warning (config is a symlink from vault)
process.env.OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING = "True";

// ── Cached compartment (tenancy) ID ──

let _compartmentId: string | null = null;

function getCompartmentId(): string {
  if (_compartmentId) return _compartmentId;

  // 1. Environment variable
  if (process.env.OCI_COMPARTMENT_ID) {
    _compartmentId = process.env.OCI_COMPARTMENT_ID;
    return _compartmentId;
  }

  // 2. Parse tenancy OCID from ~/.oci/config (tenancy = root compartment)
  try {
    const configPath = join(process.env.HOME ?? "/root", ".oci", "config");
    const config = readFileSync(configPath, "utf-8");
    const match = config.match(/^tenancy\s*=\s*(.+)$/m);
    if (match?.[1]?.trim()) {
      _compartmentId = match[1].trim();
      return _compartmentId;
    }
  } catch { /* config not readable, continue */ }

  // 3. Environment fallback
  _compartmentId = process.env.OCI_TENANCY_ID ?? "";
  return _compartmentId;
}

// ── OCI CLI wrapper ──

function ociCli(args: string[], timeout = 30_000): { ok: boolean; data: unknown; raw: string; error?: string } {
  const result = exec("oci", args, { timeout });
  if (!result.ok) {
    return { ok: false, data: null, raw: result.stderr, error: result.stderr || `exit ${result.exitCode}` };
  }
  try {
    const data = JSON.parse(result.stdout);
    return { ok: true, data, raw: result.stdout };
  } catch {
    return { ok: true, data: result.stdout, raw: result.stdout };
  }
}

// ── Instances ──

export function listInstances(): { ok: boolean; instances: CloudInstance[]; error?: string } {
  const compartmentId = getCompartmentId();
  if (!compartmentId) {
    return { ok: false, instances: [], error: "No OCI tenancy/compartment ID found. Set OCI_COMPARTMENT_ID or configure ~/.oci/config" };
  }

  const result = ociCli([
    "compute", "instance", "list",
    "--compartment-id", compartmentId,
    "--output", "json",
    "--all",
  ], 60_000);

  if (!result.ok) {
    return { ok: false, instances: [], error: result.error };
  }

  const raw = result.data as { data?: Array<Record<string, unknown>> };
  const instances: CloudInstance[] = (raw.data ?? []).map((i) => ({
    id: String(i.id ?? ""),
    name: String(i["display-name"] ?? ""),
    state: String(i["lifecycle-state"] ?? ""),
    shape: String(i.shape ?? ""),
    region: String(i.region ?? ""),
    publicIp: undefined,
    privateIp: undefined,
    ocpus: (i["shape-config"] as Record<string, unknown>)?.ocpus as number | undefined,
    memoryGb: (i["shape-config"] as Record<string, unknown>)?.["memory-in-gbs"] as number | undefined,
  }));

  return { ok: true, instances };
}

export function getInstanceState(instanceId: string): { ok: boolean; state: string; error?: string } {
  const result = ociCli([
    "compute", "instance", "get",
    "--instance-id", instanceId,
    "--output", "json",
  ]);

  if (!result.ok) {
    return { ok: false, state: "UNKNOWN", error: result.error };
  }

  const raw = result.data as { data?: { "lifecycle-state"?: string } };
  return { ok: true, state: String(raw.data?.["lifecycle-state"] ?? "UNKNOWN") };
}

export function instanceAction(
  instanceId: string,
  action: "START" | "STOP" | "RESET",
): { ok: boolean; message: string } {
  const result = ociCli([
    "compute", "instance", "action",
    "--instance-id", instanceId,
    "--action", action,
  ], 60_000);

  return {
    ok: result.ok,
    message: result.ok ? `Instance ${action} initiated` : `Failed: ${result.error}`,
  };
}

// ── Resources ──

export function listResources(): { ok: boolean; resources: CloudResource[]; error?: string } {
  const compartmentId = getCompartmentId();
  if (!compartmentId) {
    return { ok: false, resources: [], error: "No OCI tenancy/compartment ID found" };
  }

  const resources: CloudResource[] = [];

  // VCNs
  const vcnResult = ociCli([
    "network", "vcn", "list",
    "--compartment-id", compartmentId,
    "--output", "json", "--all",
  ]);
  if (vcnResult.ok) {
    const vcns = (vcnResult.data as { data?: Array<Record<string, unknown>> }).data ?? [];
    for (const v of vcns) {
      resources.push({
        type: "vcn",
        name: String(v["display-name"] ?? ""),
        id: String(v.id ?? ""),
        details: { cidrBlock: v["cidr-block"], state: v["lifecycle-state"] },
      });
    }
  }

  // Subnets
  const subnetResult = ociCli([
    "network", "subnet", "list",
    "--compartment-id", compartmentId,
    "--output", "json", "--all",
  ]);
  if (subnetResult.ok) {
    const subnets = (subnetResult.data as { data?: Array<Record<string, unknown>> }).data ?? [];
    for (const s of subnets) {
      resources.push({
        type: "subnet",
        name: String(s["display-name"] ?? ""),
        id: String(s.id ?? ""),
        details: { cidrBlock: s["cidr-block"], state: s["lifecycle-state"] },
      });
    }
  }

  // Availability domains (needed for boot/block volumes)
  const adResult = ociCli([
    "iam", "availability-domain", "list",
    "--compartment-id", compartmentId,
    "--output", "json", "--all",
  ]);
  const ads: string[] = [];
  if (adResult.ok) {
    const adList = (adResult.data as { data?: Array<Record<string, unknown>> }).data ?? [];
    for (const ad of adList) {
      ads.push(String(ad.name ?? ""));
    }
  }

  // Boot volumes (requires --availability-domain)
  for (const ad of ads) {
    const bvResult = ociCli([
      "bv", "boot-volume", "list",
      "--compartment-id", compartmentId,
      "--availability-domain", ad,
      "--output", "json", "--all",
    ]);
    if (bvResult.ok) {
      const bootVols = (bvResult.data as { data?: Array<Record<string, unknown>> }).data ?? [];
      for (const bv of bootVols) {
        resources.push({
          type: "boot-volume",
          name: String(bv["display-name"] ?? ""),
          id: String(bv.id ?? ""),
          details: { sizeGb: bv["size-in-gbs"], state: bv["lifecycle-state"], ad },
        });
      }
    }
  }

  // Block volumes
  for (const ad of ads) {
    const volResult = ociCli([
      "bv", "volume", "list",
      "--compartment-id", compartmentId,
      "--availability-domain", ad,
      "--output", "json", "--all",
    ]);
    if (volResult.ok) {
      const vols = (volResult.data as { data?: Array<Record<string, unknown>> }).data ?? [];
      for (const vol of vols) {
        resources.push({
          type: "block-volume",
          name: String(vol["display-name"] ?? ""),
          id: String(vol.id ?? ""),
          details: { sizeGb: vol["size-in-gbs"], state: vol["lifecycle-state"], ad },
        });
      }
    }
  }

  // Object Storage buckets
  const nsResult = ociCli(["os", "ns", "get", "--output", "json"]);
  if (nsResult.ok) {
    const ns = (nsResult.data as { data?: string }).data;
    if (ns) {
      const bucketResult = ociCli([
        "os", "bucket", "list",
        "--compartment-id", compartmentId,
        "--namespace-name", ns,
        "--output", "json", "--all",
      ]);
      if (bucketResult.ok) {
        const buckets = (bucketResult.data as { data?: Array<Record<string, unknown>> }).data ?? [];
        for (const b of buckets) {
          resources.push({
            type: "object-storage-bucket",
            name: String(b.name ?? ""),
            id: `${ns}/${b.name}`,
            details: {
              namespace: ns,
              storageTier: b["storage-tier"],
              timeCreated: b["time-created"],
            },
          });
        }
      }
    }
  }

  return { ok: true, resources };
}

// ── Costs ──

function monthLabel(d: Date): string {
  return `${d.toLocaleString("en-US", { month: "long" })} ${d.getFullYear()}`;
}

/**
 * Query OCI costs for a single month period.
 * Returns parsed cost items grouped by service.
 */
function queryMonthCosts(
  tenantId: string,
  start: Date,
  end: Date,
  period: string,
): { ok: boolean; costs: CloudCost[]; error?: string } {
  // Try the OCI Usage API (group by service + SKU for detailed breakdown)
  for (const module of ["usage-api", "metering-computation"] as const) {
    const subCmd = module === "usage-api"
      ? ["usage-summary", "request-summarized-usages"]
      : ["usage", "request-summarized-usages"];

    const result = ociCli([
      module, ...subCmd,
      "--tenant-id", tenantId,
      "--time-usage-started", start.toISOString(),
      "--time-usage-ended", end.toISOString(),
      "--granularity", "MONTHLY",
      "--query-type", "COST",
      "--group-by", JSON.stringify(["service", "skuName"]),
      "--output", "json",
    ], 60_000);

    if (!result.ok) continue;

    const raw = result.data as { data?: { items?: Array<Record<string, unknown>> } };
    const items = raw.data?.items ?? [];

    if (items.length === 0) {
      return { ok: true, costs: [{ service: "OCI (no usage charges)", amount: 0, currency: "USD", period }] };
    }

    // Aggregate costs by service, keep SKU detail for non-zero items
    const serviceMap = new Map<string, number>();
    const skuDetails: CloudCost[] = [];
    let currency = "USD";

    for (const item of items) {
      const svc = String(item.service ?? "Unknown");
      const sku = String(item["sku-name"] ?? "");
      const amt = Number(item["computed-amount"] ?? 0);
      currency = String(item.currency ?? "USD").trim() || "USD";
      serviceMap.set(svc, (serviceMap.get(svc) ?? 0) + amt);
      if (amt > 0 && sku) {
        skuDetails.push({ service: `${svc} — ${sku}`, amount: Math.round(amt * 100) / 100, currency, period });
      }
    }

    const costs: CloudCost[] = [];
    let total = 0;

    // Add service-level totals
    for (const [svc, amt] of serviceMap) {
      const rounded = Math.round(amt * 100) / 100;
      total += rounded;
      if (rounded !== 0) {
        costs.push({ service: svc, amount: rounded, currency, period });
      }
    }

    // Add SKU breakdown after service totals
    if (skuDetails.length > 1) {
      costs.push(...skuDetails.sort((a, b) => b.amount - a.amount));
    }

    if (costs.length === 0) {
      costs.push({ service: "OCI (all services within free tier)", amount: 0, currency, period });
    }

    costs.push({ service: "OCI TOTAL", amount: Math.round(total * 100) / 100, currency, period });
    return { ok: true, costs };
  }

  return { ok: false, costs: [], error: "OCI Usage API unavailable" };
}

export function getCosts(): { ok: boolean; costs: CloudCost[]; error?: string } {
  const tenantId = getCompartmentId();
  if (!tenantId) {
    return { ok: false, costs: [], error: "No OCI tenancy ID found. Set OCI_COMPARTMENT_ID or configure ~/.oci/config" };
  }

  const now = new Date();
  const start = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
  const end = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1));
  const result = queryMonthCosts(tenantId, start, end, monthLabel(now));
  if (result.ok) return result;

  // Last resort: instance-based estimation
  return getInstanceBasedCosts(tenantId, monthLabel(now));
}

/**
 * Get OCI costs across multiple months (current + N previous).
 * Returns per-month breakdown with service + SKU detail.
 */
export function getCostsHistory(months: number = 3): { ok: boolean; costs: CloudCost[]; error?: string } {
  const tenantId = getCompartmentId();
  if (!tenantId) {
    return { ok: false, costs: [], error: "No OCI tenancy ID found. Set OCI_COMPARTMENT_ID or configure ~/.oci/config" };
  }

  const now = new Date();
  const allCosts: CloudCost[] = [];

  for (let i = months - 1; i >= 0; i--) {
    const start = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
    const end = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i + 1, 1));
    const period = monthLabel(start);
    const result = queryMonthCosts(tenantId, start, end, period);
    if (result.ok) {
      allCosts.push(...result.costs);
    } else {
      allCosts.push({ service: `OCI (query failed)`, amount: 0, currency: "USD", period });
    }
  }

  return { ok: true, costs: allCosts };
}

function getInstanceBasedCosts(compartmentId: string, period: string): { ok: boolean; costs: CloudCost[]; error?: string } {
  const costs: CloudCost[] = [];
  const FREE_SHAPES = new Set(["VM.Standard.E2.1.Micro", "VM.Standard.A1.Flex"]);

  const instanceResult = ociCli([
    "compute", "instance", "list",
    "--compartment-id", compartmentId,
    "--output", "json", "--all",
  ], 60_000);

  if (instanceResult.ok) {
    const instances = (instanceResult.data as { data?: Array<Record<string, unknown>> }).data ?? [];
    for (const inst of instances) {
      const name = String(inst["display-name"] ?? "");
      const shape = String(inst.shape ?? "");
      const state = String(inst["lifecycle-state"] ?? "");
      const shapeConfig = inst["shape-config"] as Record<string, unknown> | undefined;
      const ocpus = Number(shapeConfig?.ocpus ?? 0);
      const memGb = Number(shapeConfig?.["memory-in-gbs"] ?? 0);

      const isFreeTier = FREE_SHAPES.has(shape) && (
        shape === "VM.Standard.E2.1.Micro" ||
        (shape === "VM.Standard.A1.Flex" && ocpus <= 4 && memGb <= 24)
      );

      costs.push({
        service: `${name} (${shape}, ${ocpus} OCPU, ${memGb}GB)`,
        amount: 0,
        currency: "USD",
        period: isFreeTier
          ? `${period} — Always Free (${state})`
          : `${period} — Paid tier (${state}), usage API unavailable`,
      });
    }
  }

  // Object Storage
  const nsResult = ociCli(["os", "ns", "get", "--output", "json"]);
  if (nsResult.ok) {
    const ns = (nsResult.data as { data?: string }).data;
    if (ns) {
      const bucketResult = ociCli([
        "os", "bucket", "list",
        "--compartment-id", compartmentId,
        "--namespace-name", ns,
        "--output", "json", "--all",
      ]);
      if (bucketResult.ok) {
        const buckets = (bucketResult.data as { data?: Array<Record<string, unknown>> }).data ?? [];
        for (const b of buckets) {
          costs.push({
            service: `Object Storage: ${b.name} (${b["storage-tier"] ?? "Standard"})`,
            amount: 0,
            currency: "USD",
            period: `${period} — Free tier: 20GB Standard, 50k requests/mo`,
          });
        }
      }
    }
  }

  if (costs.length === 0) {
    costs.push({ service: "OCI", amount: 0, currency: "USD", period: `${period} — usage API unavailable, no instances found` });
  }

  return {
    ok: true,
    costs,
    error: "Usage API unavailable — showing instance classification only. Actual costs may differ.",
  };
}
