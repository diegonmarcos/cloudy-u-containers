// Cloudflare Email Worker - Dual-delivery inbound email
// Two inbound legs run in PARALLEL (Promise.allSettled), each independent:
//   Google: Google Workspace via Gmail API (service account JWT).
//   Maddy:  Maddy via the c3-public-api http-to-smtp bridge (self-hosted mesh store).
//           Maddy itself durably feeds Stalwart (JMAP store) through its on-disk
//           stalwart_queue (max_tries 20), so Stalwart is NOT a third worker leg:
//           a direct worker->Stalwart leg would deliver every mail twice, as
//           neither maddy nor Stalwart dedups on Message-ID. health_mail-reconcile
//           diffs Gmail against both stores and repairs either one.
// Acceptance rule: accept if Google OR Maddy succeeded; reject (sender's MTA
//   retries) only when BOTH failed. Neither leg can bounce a mail the other holds.
// Each leg has its own inline attempt, its own background retry (ctx.waitUntil, so
//   it never blocks the SMTP accept) and its own loud lost-leg log line:
//     MESH_LEG_LOST   target=maddy   (see notifyLegLost)
//     GOOGLE_LEG_LOST target=google
//   A lost leg is never silent - that silence hid a 9-day outage in May 2026 - and
//   the missing copy is replayed later by health_mail-reconcile.
// Retry caveat: a timed-out attempt is ambiguous (the store may have kept the
//   message), so a retry after a timeout can in rare cases duplicate it.
// Copy 3: ONLY if C3 health check says mail unhealthy -> live.com (disaster backup)
// NOTE: 2026-05-09 - reverted Phase 5 cf-worker-bridge change: new Caddy route on
// gcp-proxy hadn't shipped (Phase 4 pending), worker was 404'ing -> mail down.

export const _retry = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export default {
  async email(message, env, ctx) {
    const from = message.from;
    const to = message.to;
    const messageId = message.headers.get('Message-ID') || '(no Message-ID)';
    console.log(`Email received: ${from} -> ${to} (${messageId})`);

    const rawEmail = await new Response(message.raw).text();

    // Google, Maddy and the health check all run inline and in parallel. allSettled
    // (not all) so one leg throwing can never take the others' result down with it.
    const [g, m, h] = await Promise.allSettled([
      deliverToGoogle(rawEmail, env),
      deliverToMaddy(rawEmail, to, env),
      checkMailHealth(env),
    ]);
    const googleOk = g.status === 'fulfilled' && g.value === true;
    const maddy = m.status === 'fulfilled' ? m.value : { ok: false, status: `threw: ${m.reason}` };
    const maddyOk = maddy.ok;
    const healthy = h.status === 'fulfilled' && h.value === true;
    console.log(`Results: google=${googleOk}, maddy=${maddyOk}, healthy=${healthy}`);

    // Each failed leg keeps retrying in the background. The failures seen in
    // production (452 4.4.5 rate limit, transient 5xx from the Caddy->c3-public-api
    // ->maddy hop) clear up on a short retry.
    if (!maddyOk) {
      ctx.waitUntil(
        retryLeg('Maddy', () => deliverToMaddy(rawEmail, to, env), 2, [1000, 2000], maddy.status).then(
          ({ ok, status }) => ok ? undefined :
            notifyLegLost('MESH_LEG_LOST', 'maddy', { messageId, from, to, status })
        )
      );
    }
    if (!googleOk) {
      ctx.waitUntil(
        retryLeg('Google', async () => {
          const ok = await deliverToGoogle(rawEmail, env);
          return { ok, status: ok ? 'ok' : 'gmail import failed' };
        }, 2, [1000, 2000], 'gmail import failed').then(
          ({ ok, status }) => ok ? undefined :
            notifyLegLost('GOOGLE_LEG_LOST', 'google', { messageId, from, to, status })
        )
      );
    }

    // If health check says unhealthy, send disaster backup to live.com
    if (!healthy) {
      ctx.waitUntil(forwardToBackup(message, env, `mail health: unhealthy`));
    }

    // Accept as long as at least one durable copy landed.
    if (googleOk || maddyOk) {
      return;
    }

    // Both legs failed - reject so the sending MTA retries rather than us silently
    // dropping the message.
    console.error(`Google and Maddy delivery both failed - rejecting`);
    message.setReject(`Google and Maddy delivery both failed`);
  }
};

// ── Per-leg background retry ──────────────────────────────────────────────────
// Bounded retry; `attempts` is the number of EXTRA attempts after the inline one
// failed. Each attempt keeps its own AbortController timeout in the leg function.
export async function retryLeg(name, attemptFn, attempts, backoffsMs, firstStatus) {
  let lastStatus = firstStatus ?? 'unknown';
  for (let i = 0; i < attempts; i++) {
    const delay = backoffsMs[i] ?? backoffsMs[backoffsMs.length - 1];
    console.warn(`${name} delivery failed (${lastStatus}), retry ${i + 1}/${attempts} in ${delay}ms`);
    await _retry.sleep(delay);
    let r;
    try { r = await attemptFn(); } catch (e) { r = { ok: false, status: `threw: ${e.message}` }; }
    if (r.ok) return { ok: true, status: r.status };
    lastStatus = r.status;
  }
  return { ok: false, status: lastStatus };
}

// ── Loud failure signal for a lost leg ────────────────────────────────────────
// No ntfy/Telegram/webhook/KV/D1/Queue binding exists in this worker's wrangler.toml,
// so per policy we do not invent new Cloudflare infrastructure here. This emits a
// durable, stable-prefixed log line (MESH_LEG_LOST / GOOGLE_LEG_LOST) carrying
// everything needed to replay the message; an external Workers Logs alert can
// alarm on the prefix. If a notification binding is added later, wire it in here.
export async function notifyLegLost(marker, target, { messageId, from, to, status }) {
  console.error(
    `${marker} target=${target} message_id=${messageId} from=${from} to=${to} status=${status}`
  );
}

// ── Maddy delivery via http-to-smtp-proxy-api ────────────────────────────────
async function deliverToMaddy(rawEmail, to, env) {
  try {
    const controller = new AbortController();
    // 25s, not 10s. Measured on gcp-proxy's Caddy access log over a week of real
    // inbound mail (n=177), this request ran p50=6.2s, p90=10.02s, max=39.4s —
    // so a 10s abort was killing roughly a tenth of inbound mail before the mesh
    // leg ever reached maddy. That was a client-side self-inflicted loss, not an
    // upstream failure, and a large part of why the mirror felt flaky.
    //
    // Two different causes sat behind that latency. The first, a JWKS refetch on
    // every introspect-proxy request, was fixed in ccb389bcc and that hop is now
    // ~1ms. What remains is maddy's own SPF/DMARC evaluation: senders with long
    // include chains (GitHub's SPF has 8 sequential includes) cost ~3s, and cold
    // lookups through the mesh resolver run ~1.2s each. Real deliveries still
    // measure 6-8s end to end because of it.
    //
    // So the headroom is still needed: SPF cost varies per sender and spikes well
    // past 10s. Do not lower this until inbound delivery is measured fast.
    // Capped at 25s deliberately: the Workers wall-clock ceiling is ~30s, and a
    // worker killed at the ceiling never reaches the accept/reject decision at
    // all, which is worse than a failed mesh leg. Leave headroom.
    const timeoutId = setTimeout(() => controller.abort(), 25000);
    const response = await fetch(env.HTTP_TO_SMTP_PROXY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        // Bearer auth gates Caddy's forward_auth (api.diegonmarcos.com/http-to-smtp-proxy-api
        // is auth=bearer; introspect-proxy validates against Authelia JWKS).
        'Authorization': `Bearer ${env.C3_BEARER_TOKEN}`,
        // X-API-Key kept as defence-in-depth: http-to-smtp-proxy-api Rust binary validates it
        // even after Caddy passes through. Will be retired when the binary is
        // updated to trust upstream auth-only.
        'X-API-Key': env.HTTP_TO_SMTP_PROXY_API_KEY,
        'X-Original-To': to,
      },
      body: rawEmail,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const bodyText = await response.text();
      console.error(`Maddy http-to-smtp-proxy-api error: ${response.status} ${bodyText}`);
      return { ok: false, status: `HTTP ${response.status}: ${bodyText}`.slice(0, 200) };
    }
    console.log(`Maddy: delivered via http-to-smtp-proxy-api`);
    return { ok: true, status: 'ok' };
  } catch (e) {
    console.error(`Maddy http-to-smtp-proxy-api failed: ${e.message}`);
    return { ok: false, status: e.message };
  }
}

// ── Google Workspace delivery via Gmail API + Service Account JWT ────
// Uses multipart upload so we can set labelIds. Without explicit INBOX,
// messages.import drops into All Mail only — invisible from a normal inbox view.
async function deliverToGoogle(rawEmail, env) {
  try {
    const accessToken = await getGoogleAccessToken(env);
    if (!accessToken) {
      console.error('Google: failed to get access token');
      return false;
    }

    const boundary = `boundary_${crypto.randomUUID()}`;
    const metadata = JSON.stringify({ labelIds: ['INBOX', 'UNREAD'] });
    const body =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: message/rfc822\r\n\r\n` +
      `${rawEmail}\r\n` +
      `--${boundary}--`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(
      `https://gmail.googleapis.com/upload/gmail/v1/users/${env.GOOGLE_EMAIL}/messages/import?uploadType=multipart&internalDateSource=dateHeader`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary="${boundary}"`,
        },
        body: body,
        signal: controller.signal,
      }
    );
    clearTimeout(timeoutId);

    if (!resp.ok) {
      const err = await resp.text();
      console.error(`Google Gmail API error: ${resp.status} ${err}`);
      return false;
    }
    const result = await resp.json();
    console.log(`Google: injected via Gmail API, id=${result.id}, labels=INBOX,UNREAD`);
    return true;
  } catch (e) {
    console.error(`Google Gmail API failed: ${e.message}`);
    return false;
  }
}

// Sign a JWT with RS256 and exchange for a Google access token
async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: env.GOOGLE_SA_EMAIL,
    sub: env.GOOGLE_EMAIL,
    scope: 'https://www.googleapis.com/auth/gmail.modify',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const header = { alg: 'RS256', typ: 'JWT' };
  const headerB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const claimsB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const unsignedToken = `${headerB64}.${claimsB64}`;

  // Import the PEM private key
  const key = await importPrivateKey(env.GOOGLE_SA_KEY);
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    key,
    new TextEncoder().encode(unsignedToken)
  );
  const signatureB64 = base64urlEncode(new Uint8Array(signature));
  const jwt = `${unsignedToken}.${signatureB64}`;

  // Exchange JWT for access token
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`Google token exchange failed: ${resp.status} ${err}`);
    return null;
  }
  const data = await resp.json();
  return data.access_token;
}

// Import a PEM RSA private key for Web Crypto API.
// Accepts: raw PEM, PEM with literal "\n" escapes, or full GCP SA JSON.
async function importPrivateKey(pem) {
  let raw = pem.trim();
  if (raw.startsWith('{')) {
    try { raw = JSON.parse(raw).private_key || raw; } catch {}
  }
  const pemBody = raw
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s/g, '');
  const binaryDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    binaryDer.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

// base64url encoding (no padding)
function base64urlEncode(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Health check ────────────────────────────────────────────────────
async function checkMailHealth(env) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(env.C3_HEALTH_URL, {
      headers: { 'Authorization': `Bearer ${env.C3_BEARER_TOKEN}` },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      console.warn(`Health check returned ${resp.status}`);
      return false;
    }
    const data = await resp.json();
    console.log(`Health: status=${data.status}, reachable=${data.reachable}`);
    return data.status === 'healthy' || data.reachable === true;
  } catch (e) {
    console.warn(`Health check failed: ${e.message}`);
    return false;
  }
}

// ── Disaster backup to live.com ─────────────────────────────────────
async function forwardToBackup(message, env, reason) {
  try {
    await message.forward(env.BACKUP_EMAIL);
    console.log(`Backup: forwarded to ${env.BACKUP_EMAIL} (reason: ${reason})`);
  } catch (e) {
    console.warn(`Backup forward failed: ${e.message}`);
  }
}
