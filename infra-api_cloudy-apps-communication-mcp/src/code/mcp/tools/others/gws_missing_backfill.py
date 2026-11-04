#!/usr/bin/env python3
"""
gws_missing_backfill.py — one-shot: copy ONLY the messages that exist in a
Google Workspace mailbox but are MISSING from Stalwart. Dedup by Message-ID
across EVERY Stalwart folder, so nothing already present is re-copied — zero
duplicates. Safe to re-run and safe to run alongside maddy's live dual-write.

Why this lives here: the primary inbound path is CF Email Routing -> Worker
`email-forwarder` -> maddy:25, which dual-writes to Stalwart (JMAP/IMAP store)
AND imports into Google Workspace. This tool is the BACKFILL half — it pulls
the historical Workspace mail that predates the dual-write into Stalwart.
It is NOT part of the steady-state flow; run it by hand for a one-time sync.

READ path — Gmail API (NOT IMAP):
  The Workspace domain's service account (diego-cli@diegonmarcos-infra-prod)
  has domain-wide delegation for Gmail *API* scopes (gmail.readonly) but NOT
  the IMAP scope https://mail.google.com/ (that returns `unauthorized_client`).
  So we read via the Gmail REST API, impersonating the target user, and never
  need an app password or user consent. If you later grant the SA the
  mail.google.com scope in the Workspace admin console, an IMAP variant would
  also be possible, but the API path needs no extra delegation.

WRITE path — Stalwart IMAP APPEND:
  Missing messages are APPENDed to Stalwart INBOX (10.0.0.3:2993) with their
  original internalDate + the \\Seen flag (historical mail, not shown unread).

RUN — inside the google-workspace-mcp container (has google-auth +
googleapiclient and, via network_mode host on oci-apps, WG reach to Stalwart):

  docker cp gws_missing_backfill.py google-workspace-mcp:/tmp/bf.py
  docker exec google-workspace-mcp /app/.venv/bin/python /tmp/bf.py <STALWART_PASSWORD>

  Optional argv[2]: impersonated user (default me@diegonmarcos.com).

Gotcha — Stalwart per-account auth rate-limit:
  Stalwart bans an account after a few auths in a short rolling window (even
  successful ones; it is the intended-but-mis-deployed fail2ban — config.toml
  is dead in v0.16, settings live in RocksDB). This tool uses a SINGLE Stalwart
  login (one connection for indexing + appending) with backoff retry, and
  NOOP-keepalive on long runs. Don't run other IMAP/JMAP logins for this
  account while it runs, and give it a quiet window before starting.
"""
import imaplib, ssl, sys, email, time, base64
import os
from google.oauth2 import service_account
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

SA_KEY = os.environ.get("GOOGLE_SERVICE_ACCOUNT_KEY_PATH", "/run/secrets/GOOGLE_SERVICE_ACCOUNT_KEY")
PASSWORD = sys.argv[1]
USER = sys.argv[2] if len(sys.argv) > 2 else "me@diegonmarcos.com"
STALW = ("10.0.0.3", 2993)

imaplib._MAXLINE = 10_000_000
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE

def gmail_service():
    creds = service_account.Credentials.from_service_account_file(
        SA_KEY, scopes=["https://www.googleapis.com/auth/gmail.readonly"], subject=USER)
    creds.refresh(Request())
    return build("gmail", "v1", credentials=creds, cache_discovery=False)

def stalwart_login(retries=6, wait=90):
    """Single Stalwart connection with backoff — survives the per-account
    auth rate-limit (bans after a few auths in a short window)."""
    last = None
    for a in range(retries):
        try:
            c = imaplib.IMAP4_SSL(*STALW, ssl_context=ctx)
            c.login(USER, PASSWORD)
            return c
        except Exception as e:
            last = e
            print(f"  stalwart login attempt {a+1} failed ({e}); waiting {wait}s", flush=True)
            time.sleep(wait)
    raise last

def mid_of(raw):
    try:
        m = email.message_from_bytes(raw)
        v = m.get("Message-ID") or m.get("Message-Id")
        return v.strip() if v else None
    except Exception:
        return None

def list_folders(c):
    out = []
    typ, data = c.list()
    if typ != "OK":
        return ["INBOX"]
    for line in data:
        if not line:
            continue
        s = line.decode(errors="replace")
        name = s.split('"')[-2] if s.rstrip().endswith('"') else s.split()[-1]
        out.append(name)
    return out

def collect_stalwart_mids(c):
    ids = set()
    for fld in list_folders(c):
        try:
            typ, _ = c.select('"%s"' % fld, readonly=True)
            if typ != "OK":
                continue
            typ, data = c.uid("search", None, "ALL")
            if typ != "OK" or not data or not data[0]:
                continue
            uids = data[0].split()
            for i in range(0, len(uids), 300):
                chunk = b",".join(uids[i:i+300])
                typ, fetched = c.uid("fetch", chunk, "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
                if typ != "OK":
                    continue
                for part in fetched:
                    if isinstance(part, tuple) and part[1]:
                        m = mid_of(part[1])
                        if m:
                            ids.add(m)
        except Exception as e:
            print(f"  (folder {fld} skipped: {e})", flush=True)
    return ids

def main():
    dst = stalwart_login()
    print("Indexing Stalwart (all folders) for Message-IDs...", flush=True)
    have = collect_stalwart_mids(dst)
    print(f"Stalwart already holds {len(have)} distinct Message-IDs", flush=True)

    svc = gmail_service()
    ids = []
    req = svc.users().messages().list(userId="me", maxResults=500)
    while req is not None:
        resp = req.execute()
        ids += [m["id"] for m in resp.get("messages", [])]
        req = svc.users().messages().list_next(req, resp)
    print(f"Gmail mailbox has {len(ids)} messages; copying the ones missing from Stalwart...", flush=True)

    dst.select("INBOX")
    copied = skipped = failed = 0
    for n, gid in enumerate(ids, 1):
        try:
            meta = svc.users().messages().get(
                userId="me", id=gid, format="metadata", metadataHeaders=["Message-Id"]).execute()
            headers = {h["name"].lower(): h["value"] for h in meta.get("payload", {}).get("headers", [])}
            msgid = (headers.get("message-id") or "").strip() or None
            internal = meta.get("internalDate")  # ms since epoch, as string
            if msgid and msgid in have:
                skipped += 1
            else:
                full = svc.users().messages().get(userId="me", id=gid, format="raw").execute()
                raw = base64.urlsafe_b64decode(full["raw"].encode())
                if not msgid:
                    msgid = mid_of(raw)
                if msgid and msgid in have:
                    skipped += 1
                else:
                    idate = None
                    try:
                        if internal:
                            idate = imaplib.Time2Internaldate(int(internal) / 1000.0)
                    except Exception:
                        idate = None
                    dst.append("INBOX", "(\\Seen)",
                               idate or imaplib.Time2Internaldate(time.time()), raw)
                    copied += 1
                    if msgid:
                        have.add(msgid)
        except Exception as e:
            print(f"  msg {gid} failed: {str(e)[:120]}", flush=True)
            failed += 1
        if n % 100 == 0:
            print(f"{n}/{len(ids)} copied={copied} skipped={skipped} failed={failed}", flush=True)
            try:
                dst.noop()  # keep the Stalwart connection alive on long runs
            except Exception:
                pass
    print(f"DONE: copied={copied} skipped={skipped} failed={failed}", flush=True)
    dst.logout()

if __name__ == "__main__":
    main()
