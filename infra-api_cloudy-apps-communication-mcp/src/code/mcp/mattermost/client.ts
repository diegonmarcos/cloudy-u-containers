/**
 * Mattermost API client with session token auth and auto-retry.
 */

const MM_URL = process.env.MM_URL || "https://chat.diegonmarcos.com";
const MM_CLAUDE_PASSWORD = process.env.MM_CLAUDE_PASSWORD || "";
const MM_TEAM_ID = process.env.MM_TEAM_ID || "x89hszqz97g6dxytbtx3p5mmkc";
const MM_ADMIN_USERNAME = process.env.MM_ADMIN_USERNAME || "me@diegonmarcos.com";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "opus";

const log = (msg: string) => process.stderr.write(`[mattermost] ${msg}\n`);

// ── Model → username mapping ───────────────────────────────────

function getUsername(): string {
  const m = CLAUDE_MODEL.toLowerCase();
  if (m.includes("opus")) return "claude-opus-ai";
  if (m.includes("sonnet")) return "claude-sonnet-ai";
  if (m.includes("haiku")) return "claude-haiku-ai";
  return "claude-opus-ai";
}

// ── Session state (cached for process lifetime) ────────────────

let token: string | null = null;
let userId: string | null = null;
let defaultDmId: string | null = null;
let diegoUserId: string | null = null;

// ── Core API helpers ───────────────────────────────────────────

async function login(): Promise<void> {
  const username = getUsername();
  log(`Logging in as ${username}...`);
  const res = await fetch(`${MM_URL}/api/v4/users/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login_id: username, password: MM_CLAUDE_PASSWORD }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Login failed (${res.status}): ${body}`);
  }
  token = res.headers.get("Token");
  if (!token) throw new Error("No Token header in login response");
  const data = await res.json();
  userId = data.id;
  log(`Logged in — userId=${userId}`);
}

async function ensureAuth(): Promise<void> {
  if (!token) await login();
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  await ensureAuth();
  const res = await fetch(`${MM_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // Token expired — re-login and retry once
    log("Token expired, re-authenticating...");
    token = null;
    await login();
    const retry = await fetch(`${MM_URL}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!retry.ok) {
      const text = await retry.text();
      throw new Error(`API ${method} ${path} failed after re-auth (${retry.status}): ${text}`);
    }
    return retry.json();
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${method} ${path} (${res.status}): ${text}`);
  }
  // Some endpoints return 204 with no body
  if (res.status === 204) return {};
  return res.json();
}

// ── Channel resolution ─────────────────────────────────────────

async function getDiegoUserId(): Promise<string> {
  if (diegoUserId) return diegoUserId;
  const data = (await api("POST", "/api/v4/users/search", {
    term: MM_ADMIN_USERNAME,
  })) as Array<{ id: string }>;
  if (!data.length) throw new Error(`User not found: ${MM_ADMIN_USERNAME}`);
  diegoUserId = data[0].id;
  return diegoUserId;
}

async function getDefaultDm(): Promise<string> {
  if (defaultDmId) return defaultDmId;
  const dId = await getDiegoUserId();
  const dm = (await api("POST", "/api/v4/channels/direct", [userId, dId])) as { id: string };
  defaultDmId = dm.id;
  log(`Default DM channel: ${defaultDmId}`);
  return defaultDmId;
}

async function resolveChannel(nameOrId?: string): Promise<string> {
  if (!nameOrId) return getDefaultDm();
  // 26-char alphanumeric = channel ID
  if (/^[a-z0-9]{26}$/.test(nameOrId)) return nameOrId;
  // Otherwise look up by name in the team
  const ch = (await api("GET", `/api/v4/teams/${MM_TEAM_ID}/channels/name/${nameOrId}`)) as { id: string };
  return ch.id;
}

// ── Group DM / user search ─────────────────────────────────────

async function searchUsers(term: string): Promise<Array<{ id: string; username: string; email: string }>> {
  await ensureAuth();
  return (await api("POST", "/api/v4/users/search", { term })) as Array<{ id: string; username: string; email: string }>;
}

async function createGroupDm(userIds: string[]): Promise<{ id: string }> {
  await ensureAuth();
  // Ensure our own userId is included
  if (userId && !userIds.includes(userId)) userIds.push(userId);
  return (await api("POST", "/api/v4/channels/group", userIds)) as { id: string };
}

// ── Exports ────────────────────────────────────────────────────

export { api, ensureAuth, resolveChannel, getUsername, searchUsers, createGroupDm, userId, MM_TEAM_ID };
