// ── /tree: the Cloud-C3 hierarchy as the API serves it (#1495) ──
// The ONE declared hierarchy (shared/c3-hierarchy.json): sections > groups > pages, each page with the route patterns it owns and the
// tree prefix every one of them is also served under (/<section>/<group>/<page>/<legacy path>), plus the Containers projects and Filters.
import type { FastifyInstance } from "fastify";
import { leaves, loadHierarchy } from "../hierarchy.js";

export async function registerTreeRoutes(app: FastifyInstance) {
  const h = loadHierarchy();
  const body = {
    version: h.version,
    sections: h.sections,
    containers: { projects: h.containers.projects.map((p) => ({ id: p.id, label: p.label })), filters: h.containers.filters.map((f) => ({ id: f.id, label: f.label })), default_project: h.containers.default_project },
    pages: [...leaves(h).values()].map((l) => ({ node: l.path, label: l.label, prefix: `/${l.path}`, routes: l.api, same_as: l.same_as })),
  };
  app.get("/tree", { schema: { tags: ["Inventory"], summary: "The Cloud-C3 app hierarchy: pages, the routes each owns, the tree prefix they are also served under" } }, async () => body);
}
