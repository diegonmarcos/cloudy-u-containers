// Session lease (#1795): exactly one Claude session answers an owner message that is not a reply. Sessions POST /claim
// {session, ttl}; the first claimer holds the lease, the holder renews it with the same call, another session is refused
// until the lease expires or the holder releases it. In-memory by design: a relay restart frees the lease, and the next
// claim (every session claims at start and on each 10-minute check) re-elects a holder within one check.
export class Lease {
  constructor({ now = () => Date.now(), minTtlS = 30, maxTtlS = 3600, defaultTtlS = 900 } = {}) {
    Object.assign(this, { now, minTtlS, maxTtlS, defaultTtlS });
    this.holder = null; this.expiresAt = 0; this.since = 0; this.renewals = 0;
  }
  live() { if (this.holder && this.now() >= this.expiresAt) { this.holder = null; this.expiresAt = 0; this.since = 0; this.renewals = 0; } return this.holder; }
  ttl(s) { const t = Number.isFinite(+s) && +s > 0 ? +s : this.defaultTtlS; return Math.min(Math.max(t, this.minTtlS), this.maxTtlS); }
  claim(session, ttlS) {
    if (typeof session !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(session)) throw Object.assign(new Error('session (1-128 of [A-Za-z0-9_.:-]) required'), { status: 400 });
    const cur = this.live(), t = this.ttl(ttlS), now = this.now();
    if (cur && cur !== session) return { granted: false, holder: cur, expiresAt: this.expiresAt, retryInS: Math.ceil((this.expiresAt - now) / 1000) };
    if (cur === session) this.renewals++; else { this.holder = session; this.since = now; this.renewals = 0; }
    this.expiresAt = now + t * 1000;
    return { granted: true, holder: session, renewed: cur === session, expiresAt: this.expiresAt, ttl: t };
  }
  release(session) { const cur = this.live(); if (cur && cur === session) { this.holder = null; this.expiresAt = 0; this.since = 0; this.renewals = 0; return { released: true }; } return { released: false, holder: cur }; }
  snapshot() { const h = this.live(); return { holder: h, expiresAt: h ? this.expiresAt : null, since: h ? this.since : null, renewals: h ? this.renewals : 0 }; }
}
