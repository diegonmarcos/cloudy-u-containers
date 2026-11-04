import { exec } from "../exec.js";
import type { z } from "zod";
import type { CloudInstanceSchema, CloudResourceSchema, CloudCostSchema } from "../schemas.js";

type CloudInstance = z.infer<typeof CloudInstanceSchema>;
type CloudResource = z.infer<typeof CloudResourceSchema>;
type CloudCost = z.infer<typeof CloudCostSchema>;

// ── AWS CLI wrapper ──

function awsCli(args: string[], timeout = 30_000): { ok: boolean; data: unknown; raw: string; error?: string } {
  const result = exec("aws", args, { timeout });
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

function getRegion(): string {
  return process.env.AWS_DEFAULT_REGION ?? process.env.AWS_REGION ?? "us-east-1";
}

// ── Instances ──

export function listInstances(): { ok: boolean; instances: CloudInstance[]; error?: string } {
  const result = awsCli([
    "ec2", "describe-instances",
    "--query", "Reservations[].Instances[]",
    "--output", "json",
  ], 60_000);

  if (!result.ok) {
    return { ok: false, instances: [], error: result.error };
  }

  const raw = result.data as Array<Record<string, unknown>>;
  const instances: CloudInstance[] = (raw ?? []).map((i) => {
    const tags = (i.Tags as Array<{ Key: string; Value: string }> | undefined) ?? [];
    const name = tags.find((t) => t.Key === "Name")?.Value ?? String(i.InstanceId ?? "");
    return {
      id: String(i.InstanceId ?? ""),
      name,
      state: String((i.State as Record<string, unknown>)?.Name ?? ""),
      shape: String(i.InstanceType ?? ""),
      region: getRegion(),
      publicIp: i.PublicIpAddress ? String(i.PublicIpAddress) : undefined,
      privateIp: i.PrivateIpAddress ? String(i.PrivateIpAddress) : undefined,
    };
  });

  return { ok: true, instances };
}

// ── Resources ──

export function listResources(): { ok: boolean; resources: CloudResource[]; error?: string } {
  const resources: CloudResource[] = [];

  // S3 buckets
  const s3Result = awsCli(["s3api", "list-buckets", "--output", "json"]);
  if (s3Result.ok) {
    const raw = s3Result.data as { Buckets?: Array<Record<string, unknown>> };
    for (const b of raw.Buckets ?? []) {
      resources.push({
        type: "s3-bucket",
        name: String(b.Name ?? ""),
        id: String(b.Name ?? ""),
        details: { creationDate: b.CreationDate },
      });
    }
  }

  // VPCs
  const vpcResult = awsCli(["ec2", "describe-vpcs", "--output", "json"]);
  if (vpcResult.ok) {
    const raw = vpcResult.data as { Vpcs?: Array<Record<string, unknown>> };
    for (const v of raw.Vpcs ?? []) {
      const tags = (v.Tags as Array<{ Key: string; Value: string }> | undefined) ?? [];
      const name = tags.find((t) => t.Key === "Name")?.Value ?? String(v.VpcId ?? "");
      resources.push({
        type: "vpc",
        name,
        id: String(v.VpcId ?? ""),
        details: { cidrBlock: v.CidrBlock, state: v.State, isDefault: v.IsDefault },
      });
    }
  }

  // SES identities
  const sesResult = awsCli(["ses", "list-identities", "--output", "json"]);
  if (sesResult.ok) {
    const raw = sesResult.data as { Identities?: string[] };
    for (const id of raw.Identities ?? []) {
      resources.push({
        type: "ses-identity",
        name: id,
        id,
        details: {},
      });
    }
  }

  return { ok: true, resources };
}

// ── Costs ──

function monthLabel(d: Date): string {
  return `${d.toLocaleString("en-US", { month: "long" })} ${d.getFullYear()}`;
}

export function getCosts(): { ok: boolean; costs: CloudCost[]; error?: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1)).toISOString().slice(0, 10);
  const period = monthLabel(now);

  const result = awsCli([
    "ce", "get-cost-and-usage",
    "--time-period", `Start=${start},End=${end}`,
    "--granularity", "MONTHLY",
    "--metrics", "UnblendedCost",
    "--group-by", "Type=DIMENSION,Key=SERVICE",
    "--output", "json",
  ], 60_000);

  if (!result.ok) {
    return { ok: false, costs: [], error: `AWS Cost Explorer unavailable: ${result.error}` };
  }

  const raw = result.data as {
    ResultsByTime?: Array<{
      Groups?: Array<{ Keys: string[]; Metrics: { UnblendedCost: { Amount: string; Unit: string } } }>;
    }>;
  };

  const groups = raw.ResultsByTime?.[0]?.Groups ?? [];
  if (groups.length === 0) {
    return { ok: true, costs: [{ service: "AWS (no charges this month)", amount: 0, currency: "USD", period }] };
  }

  const costs: CloudCost[] = [];
  let total = 0;
  let currency = "USD";

  for (const g of groups) {
    const svc = g.Keys[0] ?? "Unknown";
    const amt = Math.round(Number(g.Metrics.UnblendedCost.Amount) * 100) / 100;
    currency = g.Metrics.UnblendedCost.Unit;
    if (amt !== 0) {
      costs.push({ service: svc, amount: amt, currency, period });
      total += amt;
    }
  }

  if (costs.length === 0) {
    costs.push({ service: "AWS (all services within free tier)", amount: 0, currency, period });
  }

  costs.push({ service: "AWS TOTAL", amount: Math.round(total * 100) / 100, currency, period });
  return { ok: true, costs };
}
