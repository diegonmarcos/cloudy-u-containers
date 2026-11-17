// Health and mode-switch state machine for Bot A ingestion in c3bot-relay (#1579, architect decision: ONE bot token).
// Only one consumer may ever read Bot A, so the two ingestion paths are two MODES of the same token, never concurrent:
//   webhook : setWebhook is active, Telegram pushes to the public edge route (primary).
//   polling : the webhook is unhealthy, so the relay calls deleteWebhook and reads Bot A with getUpdates (fallback).
//   degraded: Bot A token or webhook secret missing; nothing can be ingested.
// To polling (any one of): setWebhook/getWebhookInfo fails, getWebhookInfo shows a recent last_error, the webhook is not
// registered at our URL and re-registering failed, or no webhook update inside the health window AND the self-test of the
// public route fails. Back to webhook: `recoverChecks` consecutive passing self-tests of the public route while polling.
// Pure and clock-injected. evaluate() returns the ACTION the caller must run: 'deleteWebhook' (entering polling) or
// 'setWebhook' (leaving it); the caller reports failures back through actionFailed().

export class Failover {
  constructor({ windowMs = 600000, recoverChecks = 2, configured = true, now = Date.now } = {}) {
    this.windowMs = windowMs; this.recoverChecks = recoverChecks; this.configured = configured; this.now = now;
    this.startedAt = now();
    this.lastWebhookAt = 0;     // last real webhook delivery (self-tests do not count)
    this.state = configured ? 'webhook' : 'degraded';
    this.reason = configured ? null : 'bot A token or webhook secret not configured';
    this.since = this.startedAt;
    this.good = 0;
    this.transitions = [];      // last 20: {at, from, to, reason}
  }
  noteWebhookUpdate() { this.lastWebhookAt = this.now(); }
  get silent() { return this.now() - Math.max(this.lastWebhookAt, this.startedAt) > this.windowMs; }
  get polling() { return this.state === 'polling'; }
  // sig: { infoError?, notRegistered?, lastErrorAt?, lastErrorMessage?, selfTestOk?: bool|null }
  // Returns { state, needSelfTest, action }.
  evaluate(sig = {}) {
    if (this.state === 'degraded') return { state: this.state, needSelfTest: false, action: null };
    const t = this.now();
    if (this.state === 'polling') {
      if (sig.selfTestOk == null) return { state: this.state, needSelfTest: true, action: null };
      if (!sig.selfTestOk) { this.good = 0; return { state: this.state, needSelfTest: false, action: null }; }
      if (++this.good >= this.recoverChecks) { this.#to('webhook', null); return { state: this.state, needSelfTest: false, action: 'setWebhook' }; }
      return { state: this.state, needSelfTest: false, action: null };
    }
    let bad = null;
    if (sig.infoError) bad = `getWebhookInfo/setWebhook failed: ${sig.infoError}`;
    else if (sig.notRegistered) bad = 'webhook not registered at the relay url and setWebhook failed';
    else if (sig.lastErrorAt && t - sig.lastErrorAt <= this.windowMs && sig.lastErrorAt > this.lastWebhookAt) bad = `telegram reports a delivery error: ${sig.lastErrorMessage || 'unknown'}`;
    else if (this.silent) {
      if (sig.selfTestOk == null) return { state: this.state, needSelfTest: true, action: null };
      if (sig.selfTestOk === false) bad = `no webhook update for ${Math.round(this.windowMs / 1000)}s and the public route self-test failed`;
    }
    if (bad) { this.good = 0; this.#to('polling', bad); return { state: this.state, needSelfTest: false, action: 'deleteWebhook' }; }
    return { state: this.state, needSelfTest: false, action: null };
  }
  // The caller could not perform the action (deleteWebhook failed: keep polling blocked; setWebhook failed: stay in polling).
  actionFailed(action, why) {
    if (action === 'setWebhook' && this.state === 'webhook') { this.good = 0; this.#to('polling', `setWebhook failed: ${why}`); }
  }
  #to(next, reason) {
    if (next === this.state) { this.reason = reason; return; }
    this.transitions.push({ at: this.now(), from: this.state, to: next, reason });
    if (this.transitions.length > 20) this.transitions.shift();
    this.state = next; this.reason = reason; this.since = this.now();
  }
  snapshot() {
    return {
      mode: this.state, state: this.state, reason: this.reason, since: this.since,
      lastWebhookAt: this.lastWebhookAt || null, windowS: Math.round(this.windowMs / 1000),
      fallback: this.state === 'degraded' ? 'degraded: Bot A token or webhook secret missing' : (this.state === 'polling' ? 'active (Bot A getUpdates)' : 'standby (same Bot A token, deleteWebhook + getUpdates)'),
      transitions: this.transitions,
    };
  }
}
