// mattermost.mjs — Mattermost bot transport: WebSocket bridge.
//
// Single instance, gated by MATTERMOST_ENABLED (see gateway.mjs's env var
// list). Zero npm dependencies: Node 22 global WebSocket + fetch.
import { routeToGoose } from "./route.mjs";

export const startMattermost = () => {
  const enabled = process.env.MATTERMOST_ENABLED;
  const mmUrl   = process.env.MATTERMOST_URL;
  const mmToken = process.env.MATTERMOST_TOKEN;

  if (enabled !== "true") { console.log("[gateway] mattermost: MATTERMOST_ENABLED != true — skipping"); return; }
  if (!mmToken)           { console.log("[gateway] mattermost: MATTERMOST_TOKEN not set — skipping"); return; }
  if (!mmUrl)             { console.log("[gateway] mattermost: MATTERMOST_URL not set — skipping"); return; }
  console.log("[gateway] mattermost: connecting to", mmUrl);

  // Resolve the bot's own user id so we can skip self-echo.
  // ponytail: we do a one-shot REST call at connect time; if it fails we log and
  // set botUserId to null (posts will still be processed but self-echo may loop once).
  let botUserId = null;
  const fetchBotUserId = async () => {
    try {
      const res = await fetch(`${mmUrl}/api/v4/users/me`, {
        headers: { Authorization: `Bearer ${mmToken}` },
      });
      const user = await res.json();
      botUserId = user.id;
      console.log(`[gateway] mattermost: bot user id = ${botUserId}`);
    } catch (err) {
      console.error("[gateway] mattermost: could not fetch bot user id:", err.message);
    }
  };

  const postReply = (channel_id, message) =>
    fetch(`${mmUrl}/api/v4/posts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${mmToken}`,
      },
      body: JSON.stringify({ channel_id, message }),
    }).catch((err) => console.error("[gateway] mattermost: post reply error:", err.message));

  let backoff = 1000;

  const connect = async () => {
    await fetchBotUserId();
    const wsUrl = mmUrl.replace(/^http/, "ws") + "/api/v4/websocket";
    const ws = new WebSocket(wsUrl);

    ws.addEventListener("open", () => {
      backoff = 1000;
      console.log("[gateway] mattermost: websocket open, authenticating");
      ws.send(JSON.stringify({
        seq: 1,
        action: "authentication_challenge",
        data: { token: mmToken },
      }));
    });

    ws.addEventListener("message", async (ev) => {
      let payload;
      try { payload = JSON.parse(ev.data); } catch { return; }
      if (payload.event !== "posted") return;
      let post;
      try { post = JSON.parse(payload.data?.post ?? "{}"); } catch { return; }
      // Skip self-echo (author check).
      // If botUserId was not available at connect time, re-fetch it now (cheap: only
      // runs when null).  If it is still null after the retry, skip this post entirely
      // rather than risk an infinite echo loop.
      if (botUserId === null) await fetchBotUserId();
      if (botUserId === null || post.user_id === botUserId) return;
      if (!post.message) return;
      const conversationKey = `mattermost:${post.channel_id}`;
      // Tell the model where it's speaking — "posted" events carry the
      // channel's display name alongside the post itself, no extra lookup.
      const channelName = payload.data?.channel_display_name;
      const platformContext = channelName
        ? `Mattermost context: you are replying in channel "${channelName}"`
        : undefined;
      const reply = await routeToGoose(post.message, conversationKey, undefined, platformContext);
      await postReply(post.channel_id, reply);
    });

    ws.addEventListener("error", (ev) => {
      console.error("[gateway] mattermost: websocket error:", ev.message ?? "(no message)");
    });

    ws.addEventListener("close", () => {
      console.log(`[gateway] mattermost: websocket closed — reconnecting in ${backoff}ms`);
      setTimeout(() => { backoff = Math.min(backoff * 2, 30000); connect(); }, backoff);
    });
  };

  connect().catch((err) => console.error("[gateway] mattermost: connect failed:", err.message));
};
