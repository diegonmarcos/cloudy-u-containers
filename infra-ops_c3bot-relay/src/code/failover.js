// Health and failover state machine for the two ingestion paths of c3bot-relay (#1579).
//   primary  : Bot A (the c3-bot) in webhook mode, pushed to the public edge route.
//   fallback : Bot B polling getUpdates, ONLY while the primary is unhealthy. Webhook and getUpdates never share a token.
// Pure and clock-injected: server.js feeds it observations, tests drive it directly.
//
// States
//   webhook  : primary healthy, Bot B idle.
//   fallback : primary unhealthy and a Bot B token exists: Bot B polls.
//   degraded : primary unhealthy and no Bot B token: nothing to fail over to, reported as degraded.
// Unhealthy (any one of):
//   - getWebhookInfo errored, or the webhook is not registered at our URL (and re-registering failed)
//   - Telegram reports a recent delivery error (last_error_date inside the health window)
//   - no webhook update inside the health window AND the self-test of the public route fails
// A quiet chat with a passing self-test is healthy. Recovery needs `recoverChecks` consecutive healthy evaluations.

export class Failover {
  constructor({ windowMs = 600000, recoverChecks = 2, hasFallback = false, now = Date.now } = {}) {
    this.windowMs = windowMs; this.recoverChecks = recoverChecks; this.hasFallback = hasFallback; this.now = now;
    this.startedAt = now();
    this.lastWebhookAt = 0;     // last webhook delivery (self-tests do not count)
    this.state = 'webhook';
    this.reason = null;         // why the primary is unhealthy, null while healthy
    this.since = this.startedAt;
    this.good = 0;
    this.transitions = [];      // last 20: {at, from, to, reason}
  }
  noteWebhookUpdate() { this.lastWebhookAt = this.now(); }
  get silent() { return this.now() - Math.max(this.lastWebhookAt, this.startedAt) > this.windowMs; }
  // sig: { infoError?: string, notRegistered?: bool, lastErrorAt?: ms epoch, selfTestOk?: bool|null }
  // Returns { state, needSelfTest }: needSelfTest means the caller must run the self-test and evaluate again.
  evaluate(sig = {}) {
    const t = this.now();
    let bad = null;
    if (sig.infoError) bad = `getWebhookInfo failed: ${sig.infoError}`;
    else if (sig.notRegistered) bad = 'webhook not registered at the relay url';
    else if (sig.lastErrorAt && t - sig.lastErrorAt <= this.windowMs && sig.lastErrorAt > this.lastWebhookAt) bad = `telegram reports a delivery error: ${sig.lastErrorMessage || 'unknown'}`;
    else if (this.silent) {
      if (sig.selfTestOk == null) return { state: this.state, needSelfTest: true };
      if (sig.selfTestOk === false) bad = `no webhook update for ${Math.round(this.windowMs / 1000)}s and the self-test failed`;
    }
    if (bad) { this.good = 0; this.#to(this.hasFallback ? 'fallback' : 'degraded', bad); }
    else if (this.state !== 'webhook') { if (++this.good >= this.recoverChecks) this.#to('webhook', null); }
    else this.good = 0;
    return { state: this.state, needSelfTest: false };
  }
  #to(next, reason) {
    if (next === this.state) { this.reason = reason; return; }
    this.transitions.push({ at: this.now(), from: this.state, to: next, reason });
    if (this.transitions.length > 20) this.transitions.shift();
    this.state = next; this.reason = reason; this.since = this.now();
  }
  get pollFallback() { return this.state === 'fallback'; }
  snapshot() {
    return {
      state: this.state, reason: this.reason, since: this.since, hasFallback: this.hasFallback,
      lastWebhookAt: this.lastWebhookAt || null, windowS: Math.round(this.windowMs / 1000),
      fallback: this.hasFallback ? (this.state === 'fallback' ? 'active' : 'standby') : 'degraded: Bot B token missing',
      transitions: this.transitions,
    };
  }
}
