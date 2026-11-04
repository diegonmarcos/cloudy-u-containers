# tools/others — auxiliary mail utilities (not MCP tools)

One-off operator scripts that don't belong in the steady-state MCP tool set.
Run them by hand; they are not wired into the MCP server.

## Mail architecture context

oci-mail runs **two stores**:

- **maddy** — inbound MX (WG-only :25) + outbound relay + its own imapsql store.
- **stalwart** — the JMAP/IMAP store clients read (:2443 / :2993).

Inbound: CF Email Routing → Worker `email-forwarder` → `/pub/mail/http-to-smtp`
→ maddy:25. maddy **dual-writes**: `deliver_to &local_mailboxes` (its own store)
**and** `deliver_to &stalwart_relay` (tcp://10.0.0.3:2025) — so new mail lands in
both stores atomically. The Worker also imports a copy into Google Workspace.

These scripts backfill mail that predates the dual-write.

## Scripts

### `gws_missing_backfill.py`
Copy ONLY the messages missing from Stalwart out of a Google Workspace mailbox.
Dedups by Message-ID across every Stalwart folder → zero duplicates.

- READ: Gmail **REST API** (`gmail.readonly`) impersonating the user via the
  domain-wide-delegation service account (diego-cli@diegonmarcos-infra-prod).
  The SA is delegated the API scope but NOT the IMAP scope
  `https://mail.google.com/` (that mints `unauthorized_client`), so the API is
  the only no-consent read path. No app password, no user consent.
- WRITE: Stalwart IMAP APPEND to INBOX with original internalDate + `\Seen`.
- RUN inside the google-workspace-mcp container (has google-auth +
  googleapiclient and, via network_mode host, WG reach to Stalwart):

    docker cp gws_missing_backfill.py google-workspace-mcp:/tmp/bf.py
    docker exec -u 0 google-workspace-mcp chmod 644 /tmp/bf.py
    docker exec google-workspace-mcp /app/.venv/bin/python /tmp/bf.py <STALWART_PASSWORD>

## Gotchas
- Stalwart has an aggressive per-**account** auth rate-limit (bans after a few
  auths in a short rolling window, even successful ones — the intended
  fail2ban is mis-deployed: config.toml is dead in v0.16, settings live in
  RocksDB). It clears within ~1 min of quiet. This script uses a SINGLE
  Stalwart login (one connection for index + append) with backoff retry and
  NOOP keepalive. Don't run other IMAP/JMAP logins for the account, on ANY
  host, while it runs (the limit is per-account, not per-IP).
- Append target is Stalwart INBOX with original internalDate + `\Seen`.
