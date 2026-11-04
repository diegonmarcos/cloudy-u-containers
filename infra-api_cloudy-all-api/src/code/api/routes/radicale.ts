import type { FastifyInstance } from "fastify";
import { rawHttpRequest } from "../../shared/http.js";
import { XMLParser } from "fast-xml-parser";
import { registry } from "../../registry/index.js";

const RADICALE_BASE = registry.getBaseUrl("radicale") ?? "http://10.0.0.6:5232";

function radicaleRequest(method: string, path: string, body?: string): unknown {
  const user = process.env.RADICALE_USER ?? "";
  const pass = process.env.RADICALE_PASSWORD ?? "";
  const auth = Buffer.from(`${user}:${pass}`).toString("base64");

  const headers: Record<string, string> = {
    Authorization: `Basic ${auth}`,
  };
  if (body) {
    headers["Content-Type"] = "application/xml; charset=utf-8";
  }

  const result = rawHttpRequest(method, `${RADICALE_BASE}${path}`, body, 10_000, headers);
  if (!result.ok) return { error: result.error, status: result.status };

  if (typeof result.raw === "string" && result.raw.includes("<?xml")) {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
    return parser.parse(result.raw);
  }
  return result.data;
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:displayname/>
    <D:resourcetype/>
    <D:getcontenttype/>
  </D:prop>
</D:propfind>`;

export async function registerRadicaleRoutes(app: FastifyInstance) {
  app.get("/radicale/calendars", {
    schema: {
      tags: ["Radicale"],
      summary: "List calendars",
    },
  }, async () => {
    const user = process.env.RADICALE_USER ?? "";
    return radicaleRequest("PROPFIND", `/${user}/`, PROPFIND_BODY);
  });

  app.get("/radicale/contacts", {
    schema: {
      tags: ["Radicale"],
      summary: "List contact collections",
    },
  }, async () => {
    const user = process.env.RADICALE_USER ?? "";
    return radicaleRequest("PROPFIND", `/${user}/`, PROPFIND_BODY);
  });

  app.get<{ Params: { collection: string } }>("/radicale/events/:collection", {
    schema: {
      tags: ["Radicale"],
      summary: "Get events from a calendar collection",
      params: {
        type: "object",
        properties: { collection: { type: "string" } },
        required: ["collection"],
      },
    },
  }, async (req) => {
    const user = process.env.RADICALE_USER ?? "";
    return radicaleRequest("PROPFIND", `/${user}/${req.params.collection}/`, PROPFIND_BODY);
  });
}
