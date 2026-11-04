/**
 * Meta-tool — single entry point that dispatches to all 10 Mattermost handlers.
 * Replaces individual tool registrations with one `mattermost` tool.
 *
 * Methods:
 *   read              — Read recent messages from a channel
 *   post              — Post a message to a channel
 *   reply             — Reply to a message in a thread
 *   channels          — List channels the bot has access to
 *   channels_grouped  — List channels grouped by category prefix
 *   react             — Add an emoji reaction to a post
 *   user_search       — Search for users by username or email
 *   create_group_dm   — Create a group DM with multiple users
 *   add_to_channel    — Add a user to a channel
 *   categories        — List sidebar channel categories with their channels
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { api, ensureAuth, resolveChannel, getUsername, searchUsers, createGroupDm, MM_TEAM_ID } from "./client.js";

// ── interfaces ────────────────────────────────────────────────────────────────

interface Post {
  id: string;
  channel_id: string;
  user_id: string;
  message: string;
  create_at: number;
  root_id: string;
}

interface PostsResponse {
  order: string[];
  posts: Record<string, Post>;
}

interface Channel {
  id: string;
  type: string;
  name: string;
  display_name: string;
}

// ── helper: resolve current user ID ──────────────────────────────────────────

async function getUserId(): Promise<string> {
  await ensureAuth();
  const me = (await api("GET", "/api/v4/users/me")) as { id: string };
  return me.id;
}

// ── method enum ───────────────────────────────────────────────────────────────

const METHODS = [
  "read",
  "post",
  "reply",
  "channels",
  "channels_grouped",
  "react",
  "user_search",
  "create_group_dm",
  "add_to_channel",
  "categories",
] as const;

type Method = typeof METHODS[number];

// ── handler map ───────────────────────────────────────────────────────────────

type HandlerResult = { content: Array<{ type: "text"; text: string }> };

const handlers: Record<Method, (params: Record<string, unknown>) => Promise<HandlerResult>> = {

  read: async (params) => {
    const channel = params.channel as string | undefined;
    const limit = (params.limit as number | undefined) ?? 10;
    const chId = await resolveChannel(channel);
    const data = (await api("GET", `/api/v4/channels/${chId}/posts?per_page=${limit}`)) as PostsResponse;
    const { posts } = data;

    const allPosts = Object.values(posts).sort((a, b) => a.create_at - b.create_at);

    const userIds = [...new Set(allPosts.map((p) => p.user_id))];
    const userMap = new Map<string, string>();
    for (const uid of userIds) {
      const u = (await api("GET", `/api/v4/users/${uid}`)) as { username: string };
      userMap.set(uid, u.username);
    }

    const lines = allPosts.map((p) => {
      const time = new Date(p.create_at).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      });
      const user = userMap.get(p.user_id) || "unknown";
      const thread = p.root_id ? " [thread]" : "";
      return `[${time}] @${user}${thread}: ${p.message}`;
    });

    return { content: [{ type: "text" as const, text: lines.join("\n") || "(no messages)" }] };
  },

  post: async (params) => {
    const message = params.message as string;
    const channel = params.channel as string | undefined;
    const chId = await resolveChannel(channel);
    const post = (await api("POST", "/api/v4/posts", {
      channel_id: chId,
      message,
    })) as { id: string; channel_id: string };

    const username = getUsername();
    return {
      content: [{ type: "text" as const, text: `Posted to channel ${chId} as @${username} (id: ${post.id})` }],
    };
  },

  reply: async (params) => {
    const post_id = params.post_id as string;
    const message = params.message as string;
    const original = (await api("GET", `/api/v4/posts/${post_id}`)) as Post;
    const rootId = original.root_id || post_id;

    const reply = (await api("POST", "/api/v4/posts", {
      channel_id: original.channel_id,
      message,
      root_id: rootId,
    })) as { id: string };

    return {
      content: [{ type: "text" as const, text: `Replied in thread ${rootId} (reply id: ${reply.id})` }],
    };
  },

  channels: async () => {
    const uid = await getUserId();
    const channels = (await api(
      "GET",
      `/api/v4/users/${uid}/teams/${MM_TEAM_ID}/channels`
    )) as Channel[];

    const typeLabel: Record<string, string> = {
      O: "Public",
      P: "Private",
      D: "DM",
      G: "Group",
    };

    const lines = [
      "Type    | Name                 | Display Name",
      "--------|----------------------|-------------",
    ];
    for (const ch of channels) {
      const t = (typeLabel[ch.type] || ch.type).padEnd(7);
      const n = ch.name.substring(0, 20).padEnd(20);
      lines.push(`${t} | ${n} | ${ch.display_name || "-"}`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },

  channels_grouped: async () => {
    const uid = await getUserId();
    const channels = (await api(
      "GET",
      `/api/v4/users/${uid}/teams/${MM_TEAM_ID}/channels`
    )) as Channel[];

    const groups: Record<string, string[]> = {};
    for (const ch of channels) {
      if (ch.type === "D" || ch.type === "G") continue;
      const cat = ch.name.includes("_") ? ch.name.split("_")[0] : "general";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(ch.display_name || ch.name);
    }

    const lines: string[] = [];
    for (const [cat, chs] of Object.entries(groups).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`## ${cat} (${chs.length})`);
      for (const name of chs.sort()) lines.push(`  - ${name}`);
      lines.push("");
    }

    const total = Object.values(groups).reduce((s, g) => s + g.length, 0);
    lines.push(`Total: ${total} channels, ${Object.keys(groups).length} groups`);

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },

  react: async (params) => {
    const post_id = params.post_id as string;
    const emoji_name = params.emoji_name as string;
    const uid = await getUserId();
    await api("POST", "/api/v4/reactions", {
      user_id: uid,
      post_id,
      emoji_name,
    });

    return {
      content: [{ type: "text" as const, text: `Reacted with :${emoji_name}: on post ${post_id}` }],
    };
  },

  user_search: async (params) => {
    const term = params.term as string;
    const users = await searchUsers(term);
    if (!users.length) return { content: [{ type: "text" as const, text: `No users found for "${term}"` }] };

    const lines = [
      "ID                         | Username             | Email",
      "---------------------------|----------------------|------",
    ];
    for (const u of users) {
      lines.push(`${u.id} | ${u.username.padEnd(20)} | ${u.email || "-"}`);
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },

  create_group_dm: async (params) => {
    const user_ids = params.user_ids as string[];
    const ch = await createGroupDm(user_ids);
    return {
      content: [{ type: "text" as const, text: `Group DM created (channel id: ${ch.id})` }],
    };
  },

  add_to_channel: async (params) => {
    const channel = params.channel as string;
    const user_id = params.user_id as string;
    const chId = await resolveChannel(channel);
    const member = (await api("POST", `/api/v4/channels/${chId}/members`, {
      user_id,
    })) as { channel_id: string; user_id: string };
    return {
      content: [{ type: "text" as const, text: `Added user ${member.user_id} to channel ${member.channel_id}` }],
    };
  },

  categories: async (params) => {
    const user = params.user as string | undefined;
    let targetUid: string;
    if (user) {
      const results = (await api("POST", "/api/v4/users/search", { term: user })) as Array<{ id: string; username: string }>;
      if (!results.length) return { content: [{ type: "text" as const, text: `User not found: ${user}` }] };
      targetUid = results[0].id;
    } else {
      targetUid = await getUserId();
    }

    const data = (await api("GET", `/api/v4/users/${targetUid}/teams/${MM_TEAM_ID}/channels/categories`)) as {
      categories: Array<{ display_name: string; type: string; channel_ids: string[] }>;
    };

    const channelMap = new Map<string, string>();
    const allChannels = (await api("GET", `/api/v4/users/${targetUid}/teams/${MM_TEAM_ID}/channels`)) as Channel[];
    for (const ch of allChannels) channelMap.set(ch.id, ch.display_name || ch.name);

    const lines: string[] = [];
    for (const cat of data.categories) {
      const names = cat.channel_ids.map((id) => channelMap.get(id) || id);
      lines.push(`## ${cat.display_name} (${cat.type}) — ${names.length} channels`);
      for (const name of names.sort()) lines.push(`  - ${name}`);
      lines.push("");
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") || "(no categories)" }] };
  },
};

// ── registration ──────────────────────────────────────────────────────────────

export function registerMattermostTool(server: McpServer): void {
  server.tool(
    "mattermost",
    "Unified Mattermost access. Pass `method` to select the operation and `params` for methods that require arguments.\n\nMethods: read (channel?, limit?), post (message, channel?), reply (post_id, message), channels (), channels_grouped (), react (post_id, emoji_name), user_search (term), create_group_dm (user_ids[]), add_to_channel (channel, user_id), categories (user?).",
    {
      method: z.enum(METHODS).describe("Operation to perform"),
      params: z.record(z.unknown()).optional().describe("Optional parameters for the selected method"),
    },
    async ({ method, params }) => {
      const handler = handlers[method];
      return handler((params ?? {}) as Record<string, unknown>);
    }
  );
}
