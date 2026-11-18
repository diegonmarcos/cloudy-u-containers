# Fleet mail API: delivery status (#1802) and recipient check (#1803)

Server side of backlog tickets #1802 and #1803. It is served by
`cloudy-apps-communication-mcp` (oci-apps, port 3103), the fleet mail API, in the
same Node process as the Mail MCP. The `/v1/*` routes are answered before the MCP
transport. Code: `src/code/mcp/delivery/`. Tests: `node --test` in that folder
(registered as `tests.delivery-api` in `build.json`). They use fixtures only.

## Base URL and auth

| Use | Base URL |
|---|---|
| Apps (preferred) | `https://cloudy-apps-communication-mcp.mesh.diegonmarcos.com` |
| Path route | `https://mcp.diegonmarcos.com/cloudy-apps-communication-mcp` |

The auth is the same as the rest of this service: **WireGuard mesh only**. Caddy
has `wg_only: true`, so an off-mesh request gets 403. The listener is also bound
to the oci-apps WG address. There is no bearer token and no user login. The
caller is identified by its WG address (the first `X-Forwarded-For` hop, or the
socket peer), and rate limits are counted per caller.

Every response is `application/json` with `Cache-Control: no-store`.

### Error shape (every non-2xx)

```json
{ "error": "human readable text", "code": "machine_slug" }
```

| HTTP | code | when |
|---|---|---|
| 400 | `invalid_request` | body has the wrong shape |
| 400 | `invalid_json` | body is not JSON |
| 400 | `too_many_ids` / `too_many_addresses` | the batch is over its cap |
| 403 | `forbidden` | `/v1/internal/*` called from anywhere except the mail server |
| 404 | `not_found` | no Stalwart record for this id (the 404 body also has `id` and `messageId`) |
| 405 | `method_not_allowed` | |
| 413 | `too_large` | |
| 429 | `rate_limited` | comes with a `Retry-After` header in seconds |
| 500 | `internal` | |

---

## #1802: delivery status of a sent message

### `GET /v1/sent/{messageId}/status`

`{messageId}` takes any of these forms:

* the RFC 5322 `Message-ID` the client put on the message, URL-encoded, with or
  without `<>`. For example `%3CCAF00d1e.4711%40phone.example.org%3E` or
  `CAF00d1e.4711@phone.example.org`.
* the Stalwart queue id in hex, as printed in the SMTP reply
  `250 2.0.0 Message queued with id 40400000000002b.`

Possible answers are 200 (body below) and 404 `not_found` (no record yet, or
older than the 90-day retention).

### `POST /v1/sent/status`

```json
{ "ids": ["<CAF00d1e.4711@phone.example.org>", "40400000000002b"] }
```

The limit is 100 ids, and duplicates are collapsed. The response is
`{"results": [ ...one status object per id... ]}`. An unknown id comes back as
`{"id": "...", "found": false, "messageId": "...", "reason": "..."}` inside
`results`, not as a 404.

### Status object

Each stage is `{ "state": "ok" | "pending" | "failed", "at": RFC3339 | null, "reason": string }`.

```json
{
  "id": "<CAF00d1e.4711@phone.example.org>",
  "found": true,
  "messageId": "<CAF00d1e.4711@phone.example.org>",
  "queueId": "40400000000002b",
  "stages": {
    "submitted": { "state": "ok", "at": "2026-11-18T10:00:00.500Z",
                   "reason": "DATA handed to Stalwart by sender (MTA hook, stage data)" },
    "received":  { "state": "ok", "at": "2026-11-18T10:00:01Z", "queueId": "40400000000002b",
                   "reason": "250 2.0.0 Message queued with id 40400000000002b" },
    "sender_valid": {
      "state": "ok", "at": "2026-11-18T10:00:01Z",
      "reason": "From authorised, DKIM signed, DMARC aligned",
      "checks": {
        "from_authorized": { "state": "ok", "reason": "header From equals the envelope sender Stalwart authorised for sender",
                             "login": "sender", "from": "sender@example.org" },
        "dkim":  { "state": "ok", "d": "example.org", "selectors": ["rsa-2026"], "evidence": "signer_config",
                   "reason": "signed d=example.org (rule: sender_domain, authenticated); no signing error in the session" },
        "spf":   { "state": "ok", "domain": "example.org", "record": "v=spf1 include:... ~all", "aligned": true,
                   "reason": "SPF policy published for example.org, aligned with From" },
        "dmarc": { "state": "ok", "record": "v=DMARC1; p=quarantine; adkim=r; aspf=r", "policy": "quarantine",
                   "reason": "DKIM d=example.org aligned with From example.org (adkim=r)" }
      }
    },
    "delivered": {
      "state": "failed", "at": "2026-11-18T10:00:07Z",
      "reason": "1/3 recipient(s) failed",
      "recipients": [
        { "rcpt": "alice@remote.example", "state": "pending", "at": "2026-11-18T10:00:03Z", "hop": "relay",
          "host": "smtp.email.eu-marseille-1.oci.oraclecloud.com",
          "reason": "accepted by relay smtp.email.eu-marseille-1.oci.oraclecloud.com (250 2.0.0 Ok: queued as 7F3A2); the recipient MX's answer is not visible to the server, only a later DSN can settle it" },
        { "rcpt": "bob@remote.example", "state": "failed", "at": "2026-11-18T10:00:03Z", "hop": "relay",
          "host": "smtp.email.eu-marseille-1.oci.oraclecloud.com",
          "reason": "rejected by smtp.email.eu-marseille-1.oci.oraclecloud.com: 550 5.1.1 Recipient address rejected: suppressed (hard bounce)" },
        { "rcpt": "carol@example.org", "state": "ok", "at": "2026-11-18T10:00:04Z", "hop": "local", "host": null,
          "reason": "delivered into the local store (route local); message completed in the queue" }
      ]
    }
  }
}
```

The object can also contain `queueIds: [...]`. That happens only when one
Message-ID was queued more than once (a resend). The status always describes the
latest queue id.

### What each stage means, and where it comes from

All of the data comes from the mail server's own records. Stalwart streams them
to this API; how is described in "How the records get here" below. When a stage
has no record it stays `pending`, and its `reason` names the missing record.
Nothing is filled in by guessing.

| stage | `ok` means | source record |
|---|---|---|
| `submitted` | the client handed the full message (DATA) to Stalwart | Stalwart MtaHook, stage `data` (has the SASL login, Message-ID, header From, envelope and queue id) |
| `received` | Stalwart accepted it: `250 2.0.0 Message queued with id <hex>` | `queue.authenticated-message-queued` event |
| `sender_valid` | the account may use that From, DKIM signing applies, and DMARC is aligned | see the checks below |
| `delivered` | **every** recipient was accepted by its final hop | the per-recipient results below |

`sender_valid.checks`:

* `from_authorized`. Stalwart already refuses an envelope `MAIL FROM` that the
  account does not own (`smtp.mail-from-unauthorized`), and such a message is
  never queued. This check compares the header From with that envelope sender
  (`+tag` stripped). If they differ, it compares the header From with the
  account's own addresses and aliases in Stalwart's directory (`x:Account`).
* `dkim`. Stalwart v0.16.5 signs inside its DATA pipeline and logs nothing when
  signing succeeds. The evidence is therefore its signing configuration:
  `x:SenderAuth.dkimSignDomain` (the default rule signs `sender_domain` for
  authenticated local senders), plus an `active` `x:DkimSignature` key for that
  domain, plus the absence of any `dkim.*` signing error in the submission
  session. That is why `evidence` is `"signer_config"`. A custom signing rule
  gives `pending`; the API does not evaluate arbitrary rules.
* `spf`. This check is reported but does **not** gate `sender_valid`, because
  DMARC passes on DKIM alone. It reads the envelope domain's TXT record from a
  public resolver and checks that the domain is aligned with From.
* `dmarc`. This check gates `sender_valid`. It looks up `_dmarc.<From domain>`
  (falling back to the organisational domain), then checks DKIM alignment
  against `d=` (relaxed, or strict when `adkim=s`).

`delivered.recipients[]`: each entry is `{rcpt, state, at, reason, hop, host}`.
`hop` is `relay`, `mx`, `local`, `dsn` or `queue`.

| record | per-recipient state |
|---|---|
| `delivery.delivered` from a **relay** (`relay_hosts`: OCI Email Delivery, the Maddy leg) | `pending`. The relay's 250 is not the recipient MX's 250 |
| `delivery.delivered` from the recipient's MX | `ok` |
| `delivery.rcpt-to-rejected` with 5xx, `delivery.message-rejected` / `mail-from-rejected` with 5xx | `failed` |
| the same with 4xx, `delivery.rcpt-to-failed`, `delivery.connect-error` (a deferral; Stalwart retries) | `pending` |
| `delivery.failed` (Stalwart gave up, for example when the message expired) | `failed` |
| inbound DSN whose returned headers carry this Message-ID: `Action: failed` | `failed` |
| the same DSN with `Action: delayed` or `relayed` | `pending` |
| the same DSN with `Action: delivered` or `expanded` | `ok` |
| local-domain recipient on a message that completed in the queue | `ok` (`hop: local`) |

Once a recipient is `failed` it stays `failed`. Otherwise the latest record wins.
The overall `delivered` state is `failed` if any recipient failed, `ok` if all of
them are ok, and `pending` otherwise.

**A limit you must show the user.** OCI blocks outbound port 25, so every
non-local message leaves through the OCI Email Delivery relay. For those
recipients the best the server can know is "accepted by relay". They become `ok`
or `failed` only if a DSN comes back. OCI Email Delivery handles most bounces
itself, so many recipients will stay `pending` with that reason. Present this as
"sent, awaiting confirmation", not as an error.

---

## #1803: recipient check

### `POST /v1/recipients/check`

```json
{ "addresses": ["alice@remote.example", "anyone@catchall.example", "a@nullmx.example"] }
```

The limit is 50 addresses per request; duplicates are collapsed. The rate limit
is **60 addresses per minute per caller**. Over the limit you get 429
`rate_limited` with `Retry-After`. Results are cached per address for 6 h; an
`unknown` result is cached for only 15 min. Cached results carry `"cached": true`.

Response: `{"results": [CheckResult, ...]}`. The results come back in the order
of the deduplicated input.

```json
{
  "address": "alice@remote.example",
  "verdict": "ok",
  "reason": "mailbox confirmed by mx1.remote.example",
  "checks": {
    "syntax":      { "state": "ok", "normalized": "alice@remote.example" },
    "domain_mx":   { "state": "ok", "hosts": ["mx1.remote.example", "mx2.remote.example"] },
    "mailbox":     { "state": "exists", "host": "mx1.remote.example", "code": 250, "reason": "mx1.remote.example: 250 2.1.5 Ok" },
    "past_bounce": { "state": "none" },
    "disposable":  false,
    "role":        false,
    "size_limit":  { "bytes": 52428800, "host": "mx1.remote.example" }
  },
  "cached": false,
  "checked_at": "2026-11-18T10:05:00.000Z"
}
```

| field | values |
|---|---|
| `verdict` | `ok`, `risky`, `fail`, `unknown` |
| `checks.syntax.state` | `ok` / `fail` (+`reason`). The domain is IDNA-normalized |
| `checks.domain_mx` | `state` `ok`/`fail`/`unknown`, `hosts[]`. `implicit: true` means no MX, fell back to A/AAAA (RFC 5321 §5.1). `null_mx: true` means RFC 7505 null MX (`fail`) |
| `checks.mailbox.state` | `exists`, `does_not_exist`, `accepts_all` (catch-all), `unknown`, `not_checked` |
| `checks.past_bounce` | `{state: "none"}` or `{state: "bounced", at, reason}`, taken from the #1802 records |
| `checks.disposable`, `checks.role` | booleans (hints) |
| `checks.size_limit.bytes` | the EHLO `SIZE` value. `0` means advertised without a limit; `null` means not advertised or not reached |

Verdict rules:

* `fail`: invalid syntax, or a domain with no mail host (NXDOMAIN, null MX, or
  no MX/A/AAAA), or the recipient's own server answered 550/551/553 to RCPT
  (excluding 5.7.x policy codes).
* `risky`: a catch-all (`accepts_all`), or a mailbox that would otherwise be
  `ok` but has a past bounce, a disposable domain or a role local part. A past
  bounce also makes an unverified mailbox `risky`.
* `ok`: **only** when the probe got an explicit 250/251 for the address **and**
  rejected a random control address at the same domain (so it is not a
  catch-all) **and** no hint applies. The check never returns a false `ok`.
* `unknown`: everything else, such as a probe that cannot connect, a 4xx answer
  (greylisting or a rate limit), a 5.7.x policy refusal, or a DNS failure.

How the probe works: it runs from the server only, as EHLO, `MAIL FROM:<>`,
`RCPT TO:<addr>`, `RCPT TO:<random@domain>`, RSET, QUIT. It **never sends
DATA**; the code throws if it is asked to, and a test checks the transcript. At
most 2 MX hosts are tried, with an 8 s timeout and 4 probes at a time. Local
domains (`diegonmarcos.com`) are probed against Stalwart's own SMTP over wg0
(`10.0.0.3:2025`). Remote MX probes come from oci-apps, where **OCI blocks
outbound TCP/25**. Expect `mailbox.state: "unknown"` with
`"cannot reach <mx>:25 from the server (...)"` for external domains. Everything
else (syntax, MX, null MX, past bounce, hints) still works.

---

## How the records get here (server side)

`user-comm_tools-stalwart/build.json#delivery_ledger` declares two Stalwart
registry objects. `activate.sh` Step I upserts them through
`configs/apply-delivery-ledger.py`, matching each object by its URL:

* a **WebHook** (telemetry subscriber) that sends the listed queue, delivery,
  DSN and sender-auth events to `POST /v1/internal/stalwart/events`;
* an **MtaHook** at stage `data`, enabled for
  `!is_empty(authenticated_as) || is_empty(sender)` (authenticated submissions
  plus null-sender mail, i.e. bounces), sent to
  `POST /v1/internal/stalwart/mta-hook`. It uses `tempFailOnError: false`, and
  the API answers `{"action":"accept"}` before doing any work, so the ledger can
  never delay or reject mail.

Both ingest routes accept only oci-mail's WG addresses (`10.0.0.3`, `10.1.0.3`).
The ledger is a JSONL file at `/data/delivery-ledger.jsonl` (bind mount `./data`,
excluded from the deploy rsync). It is replayed at start, and records older than
90 days are dropped. `GET /v1/delivery/health` returns the ledger counters, with
no message data.

A message sent before this was deployed has no record, so it returns 404.
