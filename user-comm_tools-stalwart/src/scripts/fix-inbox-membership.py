#!/usr/bin/env python3
"""Re-add the Inbox mailbox to every email that lost it (idempotent, re-runnable).

Owner rule: every email keeps the Inbox mailbox; every other mailbox is a label
added on top. Mail in Sent/Drafts/Trash/Junk/Archive is exempt by default
(the owner placed it there on purpose), same as inbox_guard.rs.

Uses RFC 8620 patch paths (mailboxIds/<inbox>: true) so no other membership is
rewritten. Default is a DRY RUN (count only); pass --apply to write.

Credentials come from the environment, never argv:
  JMAP_URL (default https://localhost:2443), JMAP_USER (default
  me@diegonmarcos.com), ME_PASSWORD or ADMIN_PASSWORD.
On the mail host:
  ME_PASSWORD=$(docker exec stalwart-sorter printenv ME_PASSWORD) \
  JMAP_URL=https://10.0.0.3:2443 python3 fix-inbox-membership.py [--apply]
"""
import argparse, base64, json, os, ssl, sys, urllib.request

EXEMPT = {"sent", "drafts", "trash", "junk", "archive"}
USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write (default: dry run)")
    ap.add_argument("--include-exempt", action="store_true")
    ap.add_argument("--batch", type=int, default=200)
    a = ap.parse_args()
    base = os.environ.get("JMAP_URL", "https://localhost:2443").rstrip("/")
    user = os.environ.get("JMAP_USER", "me@diegonmarcos.com")
    pw = os.environ.get("ME_PASSWORD") or os.environ.get("ADMIN_PASSWORD")
    if not pw:
        sys.exit("ME_PASSWORD or ADMIN_PASSWORD required in the environment")
    auth = "Basic " + base64.b64encode(f"{user}:{pw}".encode()).decode()
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # mesh/bridge peer, same as the sorter

    def http(url, body=None):
        req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None,
                                     headers={"Authorization": auth, "Content-Type": "application/json"})
        return json.load(urllib.request.urlopen(req, context=ctx, timeout=120))

    sess = http(base + "/jmap/session")
    acc = sess["primaryAccounts"]["urn:ietf:params:jmap:mail"]
    api = sess["apiUrl"]
    if "://" in api:  # apiUrl may carry a public host/port; keep our base
        api = base + "/" + api.split("/", 3)[3]

    def call(calls):
        r = http(api, {"using": USING, "methodCalls": calls})["methodResponses"]
        for name, res, _ in r:
            if name == "error":
                sys.exit(f"JMAP error: {res}")
        return r

    mbs = call([["Mailbox/get", {"accountId": acc, "properties": ["name", "role"]}, "0"]])[0][1]["list"]
    inbox = next(m["id"] for m in mbs if m.get("role") == "inbox")
    exempt = [] if a.include_exempt else [m["id"] for m in mbs if m.get("role") in EXEMPT]

    def missing_ids(limit, pos=0):
        # Email/query cannot express "not in mailbox" for a single id, so use
        # a NOT/OR operator filter.
        flt = {"operator": "NOT", "conditions": [{"inMailbox": inbox}]}
        if exempt:
            flt = {"operator": "AND", "conditions": [flt] + [
                {"operator": "NOT", "conditions": [{"inMailbox": e}]} for e in exempt]}
        res = call([["Email/query", {"accountId": acc, "filter": flt, "limit": limit,
                                     "position": pos, "calculateTotal": True}, "0"]])[0][1]
        return res["ids"], res.get("total", len(res["ids"]))

    total_all = call([["Email/query", {"accountId": acc, "limit": 0, "calculateTotal": True}, "0"]])[0][1]["total"]
    in_inbox = call([["Email/query", {"accountId": acc, "filter": {"inMailbox": inbox}, "limit": 0,
                                      "calculateTotal": True}, "0"]])[0][1]["total"]
    _, missing = missing_ids(1)
    print(f"emails total={total_all} in_inbox={in_inbox} missing_inbox(non-exempt)={missing}")
    if not a.apply:
        print("dry run: nothing written (use --apply)")
        return
    fixed = 0
    while True:
        ids, _ = missing_ids(a.batch)
        if not ids:
            break
        upd = {i: {f"mailboxIds/{inbox}": True} for i in ids}
        res = call([["Email/set", {"accountId": acc, "update": upd}, "0"]])[0][1]
        ok = len(res.get("updated") or {})
        fixed += ok
        if ok == 0:
            sys.exit(f"no progress, notUpdated sample: {list((res.get('notUpdated') or {}).items())[:2]}")
        print(f"fixed {fixed}")
    _, after = missing_ids(1)
    print(f"applied: fixed={fixed} missing_inbox_after={after}")


if __name__ == "__main__":
    main()
