import Database from "better-sqlite3";
import { join } from "node:path";
const GDELT_BASE = "https://api.gdeltproject.org/api/v2/doc/doc";
const DEFAULT_TOPICS = [
    { topic: "economy", label: "Economy" },
    { topic: "technology", label: "Technology" },
    { topic: "geopolitics", label: "Geopolitics" },
    { topic: "climate change", label: "Climate" },
    { topic: "finance markets", label: "Finance" },
    { topic: "artificial intelligence", label: "AI" },
    { topic: "energy", label: "Energy" },
    { topic: "health", label: "Health" },
];
const CACHE_DIR = process.env.CACHE_DIR ?? "/app/cache";
const FETCH_INTERVAL = parseInt(process.env.FETCH_INTERVAL ?? "900", 10) * 1000;
const MAX_RECORDS = 250;
let db;
let lastFetch = null;
let fetchTimer = null;
function initDb() {
    const dbPath = join(CACHE_DIR, "gdelt-cache.db");
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      topic TEXT PRIMARY KEY,
      articles TEXT NOT NULL DEFAULT '[]',
      timeline TEXT NOT NULL DEFAULT '[]',
      tone TEXT NOT NULL DEFAULT '[]',
      fetched_at TEXT NOT NULL
    )
  `);
}
async function fetchJson(url) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) {
            console.error(`[gdelt] HTTP ${res.status} from ${url}`);
            return null;
        }
        return (await res.json());
    }
    catch (e) {
        // FIX #1: log silent failures (was previously `catch { return null }`)
        const code = e?.cause?.code ?? e?.code ?? e?.name ?? "unknown";
        console.error(`[gdelt] fetch failed: ${code} ${e?.message ?? ""} url=${url}`);
        return null;
    }
}
function buildUrl(query, mode) {
    const params = new URLSearchParams({
        query,
        mode,
        maxrecords: MAX_RECORDS.toString(),
        format: "json",
    });
    return `${GDELT_BASE}?${params}`;
}
async function fetchTopic(topic) {
    // FIX #3: sequential rather than Promise.all — 3 simultaneous requests
    // per topic was tripping GDELT per-IP rate limits. Sequential keeps
    // outbound concurrency = 1 globally; combined with the inter-topic
    // delay in fetchAllTopics, total upstream pressure stays well below
    // the (undocumented) GDELT throttle.
    const sleepMs = (n) => new Promise((r) => setTimeout(r, n));
    const artRes = await fetchJson(buildUrl(topic, "artlist"));
    await sleepMs(500);
    const tlRes = await fetchJson(buildUrl(topic, "timelinevol"));
    await sleepMs(500);
    const toneRes = await fetchJson(buildUrl(topic, "tonechart"));
    // FIX #2: don't wipe the cache when ALL three upstream calls failed.
    // Previously, fallback `?? []` silently replaced any prior good data
    // with empty arrays — single rate-limit episode = total cache loss.
    if (artRes == null && tlRes == null && toneRes == null) {
        console.error(`[gdelt] all 3 upstream calls failed for "${topic}" — preserving prior cache`);
        return;
    }
    const articles = (artRes?.articles ?? []).map((a) => ({
        url: a.url ?? "",
        title: a.title ?? "",
        seendate: a.seendate ?? "",
        socialimage: a.socialimage ?? "",
        domain: a.domain ?? "",
        language: a.language ?? "",
        sourcecountry: a.sourcecountry ?? "",
        tone: parseFloat(String(a.tone ?? 0)) || 0,
    }));
    const timeline = tlRes?.timeline?.[0]?.data?.map((d) => ({
        date: d.date ?? "",
        value: parseFloat(d.value ?? "0") || 0,
    })) ?? [];
    const tone = (toneRes?.tonechart ?? []).map((t) => ({
        url: t.url ?? "",
        title: t.title ?? "",
        tone: parseFloat(String(t.tone ?? 0)) || 0,
        domain: t.domain ?? "",
    }));
    const now = new Date().toISOString();
    const stmt = db.prepare(`
    INSERT INTO topics (topic, articles, timeline, tone, fetched_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(topic) DO UPDATE SET
      articles = excluded.articles,
      timeline = excluded.timeline,
      tone = excluded.tone,
      fetched_at = excluded.fetched_at
  `);
    stmt.run(topic, JSON.stringify(articles), JSON.stringify(timeline), JSON.stringify(tone), now);
    lastFetch = now;
}
async function fetchAllTopics() {
    console.log(`[gdelt] Fetching ${DEFAULT_TOPICS.length} topics...`);
    for (const { topic } of DEFAULT_TOPICS) {
        try {
            await fetchTopic(topic);
            console.log(`[gdelt] ✓ ${topic}`);
        }
        catch (err) {
            console.error(`[gdelt] ✗ ${topic}:`, err);
        }
        // Small delay between requests to be polite to GDELT
        await new Promise((r) => setTimeout(r, 2000));
    }
    console.log(`[gdelt] Fetch complete at ${lastFetch}`);
}
function getCachedTopic(topic) {
    const row = db.prepare("SELECT * FROM topics WHERE topic = ?").get(topic);
    return row ?? null;
}
export function getArticles(query, limit) {
    const row = getCachedTopic(query);
    if (!row)
        return [];
    const articles = JSON.parse(row.articles);
    return articles.slice(0, limit);
}
export function getTimeline(query) {
    const row = getCachedTopic(query);
    if (!row)
        return [];
    return JSON.parse(row.timeline);
}
export function getTone(query) {
    const row = getCachedTopic(query);
    if (!row)
        return [];
    return JSON.parse(row.tone);
}
export function getTopics() {
    const rows = db.prepare("SELECT * FROM topics").all();
    return DEFAULT_TOPICS.map(({ topic, label }) => {
        const row = rows.find((r) => r.topic === topic);
        if (!row)
            return { topic, label, articleCount: 0, avgTone: 0, lastFetch: "" };
        const articles = JSON.parse(row.articles);
        const avgTone = articles.length > 0 ? articles.reduce((sum, a) => sum + a.tone, 0) / articles.length : 0;
        return {
            topic,
            label,
            articleCount: articles.length,
            avgTone: Math.round(avgTone * 100) / 100,
            lastFetch: row.fetchedAt,
        };
    });
}
export function getHealth() {
    const rows = db.prepare("SELECT topic, articles FROM topics").all();
    const totalArticles = rows.reduce((sum, r) => sum + JSON.parse(r.articles).length, 0);
    return {
        cachedTopics: rows.length,
        totalArticles,
        lastFetch,
    };
}
export async function fetchOnDemand(query) {
    const row = getCachedTopic(query);
    const now = Date.now();
    if (row) {
        const age = now - new Date(row.fetchedAt).getTime();
        if (age < FETCH_INTERVAL)
            return; // Still fresh
    }
    await fetchTopic(query);
}
export function start() {
    initDb();
    // Initial fetch
    fetchAllTopics().catch((err) => console.error("[gdelt] Initial fetch error:", err));
    // Schedule periodic refresh
    fetchTimer = setInterval(() => {
        fetchAllTopics().catch((err) => console.error("[gdelt] Periodic fetch error:", err));
    }, FETCH_INTERVAL);
}
export function stop() {
    if (fetchTimer)
        clearInterval(fetchTimer);
}
