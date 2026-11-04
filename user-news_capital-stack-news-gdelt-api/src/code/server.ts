import Fastify from "fastify";
import * as gdelt from "./gdelt.ts";
import { bindHost } from "./binds.ts";
const PORT = parseInt(process.env.PORT ?? "3019", 10);
const BASE_PATH = process.env.BASE_PATH ?? "/news";
const startTime = Date.now();
const app = Fastify({ logger: true });
// ── Health (outside base path for Docker healthcheck) ──
app.get("/health", async () => {
    const { cachedTopics, totalArticles, lastFetch } = gdelt.getHealth();
    const response = {
        status: "ok",
        cachedTopics,
        totalArticles,
        lastFetch,
        uptime: Math.floor((Date.now() - startTime) / 1000),
    };
    return response;
});
// ── Articles ──
app.get(`${BASE_PATH}/articles`, async (req) => {
    const { q = "economy", limit = "50" } = req.query;
    const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 250);
    // Try cache first, fetch on-demand if missing/stale
    await gdelt.fetchOnDemand(q);
    const articles = gdelt.getArticles(q, parsedLimit);
    return { query: q, count: articles.length, articles };
});
// ── Timeline ──
app.get(`${BASE_PATH}/timeline`, async (req) => {
    const { q = "economy" } = req.query;
    await gdelt.fetchOnDemand(q);
    const timeline = gdelt.getTimeline(q);
    return { query: q, points: timeline.length, timeline };
});
// ── Tone / Sentiment ──
app.get(`${BASE_PATH}/tone`, async (req) => {
    const { q = "economy" } = req.query;
    await gdelt.fetchOnDemand(q);
    const tone = gdelt.getTone(q);
    return { query: q, count: tone.length, tone };
});
// ── Topics (pre-configured) ──
app.get(`${BASE_PATH}/topics`, async () => {
    const topics = gdelt.getTopics();
    return { topics };
});
// ── CORS headers ──
app.addHook("onSend", async (_req, reply) => {
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
});
app.options("*", async (_req, reply) => {
    reply.status(204).send();
});
// ── Start ──
async function main() {
    gdelt.start();
    try {
        const host = bindHost();
        await app.listen({ port: PORT, host });
        console.log(`[news-gdelt] Listening on ${host}:${PORT}, base path: ${BASE_PATH}`);
    }
    catch (err) {
        app.log.error(err);
        process.exit(1);
    }
}
// Graceful shutdown
for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
        gdelt.stop();
        app.close().then(() => process.exit(0));
    });
}
main();
