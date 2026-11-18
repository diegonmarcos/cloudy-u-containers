#!/usr/bin/env python3
"""Tester for health_mail-reconcile.yaml (2026-10-13).

Runs the DAG's OWN code, extracted from the YAML, not a copy of it:
  * the window block (`# >>> window` .. `# <<< window`), under sh;
  * the maddy fingerprint scan (the SCANEOF heredoc) plus the Message-ID awk
    (the AWKEOF heredoc), under sh against a fake store;
  * deliver()/is_permanent() from the repair script (`# >>> deliver`), with a
    fake SMTP client;
  * the verdict block (`# >>> verdict`), under sh, for each repair outcome.

What it proves:
  1. Gmail is queried by epoch seconds ending LAG_MINUTES ago, never by
     yyyy/mm/dd dates (Gmail reads those as midnight US Pacific, which hid the
     newest 1.5-2 days of mail from the reconciler), and the window covers the
     24h Health Mail Full window except the in-flight lag.
  2. The DAG runs at least every 4 hours.
  3. The fingerprint cache: cold start fingerprints everything (folded
     Message-ID headers included), warm runs do not re-parse cached bodies,
     deleted keys drop out and are pruned, keys without a Message-ID are
     cached but never emitted, and a key whose body file is absent is retried.
  4. Re-sends are retried only before the message is handed over (connect,
     MAIL, RCPT, 4xx); a failure during DATA is never retried in-run; 5xx is
     permanent.
  5. A partial transient miss does not fail the run; a permanent failure, a
     total failure or a crashed repair run does.

Run: python3 src/dags/test_health_mail-reconcile.py   (exit 0 = pass)
"""
import hashlib
import os
import re
import smtplib
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DAG = os.path.join(HERE, "health_mail-reconcile.yaml")

failures = []


def check(cond, label):
    print(("ok:   " if cond else "FAIL: ") + label)
    if not cond:
        failures.append(label)


def command_block(text):
    """The reconcile step's `command: |` literal, de-indented like YAML does."""
    lines = text.splitlines()
    start = next(i for i, l in enumerate(lines) if l.strip() == "command: |") + 1
    body = []
    for l in lines[start:]:
        if l.strip() and not l.startswith("      "):
            break
        body.append(l[6:] if l.startswith("      ") else "")
    return "\n".join(body) + "\n"


def between(text, start_marker, end_marker):
    a = text.index(start_marker) + len(start_marker)
    b = text.index(end_marker, a)
    return text[a:b]


def heredoc(text, tag):
    a = text.index("<<'%s'\n" % tag) + len("<<'%s'\n" % tag)
    b = text.index("\n%s\n" % tag, a)
    return text[a:b] + "\n"


def sh(script, env=None, cwd=None):
    e = dict(os.environ)
    e.update(env or {})
    return subprocess.run(["sh", "-c", script], env=e, cwd=cwd,
                          capture_output=True, text=True)


raw = open(DAG).read()
cmd = command_block(raw)

# ---- 1/2. static shape --------------------------------------------------
sched = re.search(r'^schedule:\s*"([^"]+)"', raw, re.M).group(1)
hour = sched.split()[1]
m = re.fullmatch(r"\*/(\d+)", hour)
check(m is not None and int(m.group(1)) <= 4,
      "schedule %r runs at least every 4h" % sched)
check("%Y/%m/%d" not in cmd, "no yyyy/mm/dd Gmail dates in the step")
check("LAG_DAYS" not in raw, "LAG_DAYS is gone")
check("/tmp/recon_gmail.py '$GMAIL_QUERY'" in cmd,
      "Gmail list is driven by $GMAIL_QUERY")
lag = int(re.search(r'-\s*LAG_MINUTES:\s*"(\d+)"', raw).group(1))
days = int(re.search(r'-\s*WINDOW_DAYS:\s*"(\d+)"', raw).group(1))
check(0 < lag <= 60, "LAG_MINUTES=%d is under an hour" % lag)

# ---- 1. window ----------------------------------------------------------
window = between(cmd, "# >>> window\n", "# <<< window")
NOW = 1791900000
r = sh(window + 'echo "$FROM_EPOCH $TO_EPOCH $GMAIL_QUERY"',
       {"NOW": str(NOW), "LAG_MINUTES": str(lag), "WINDOW_DAYS": str(days)})
check(r.returncode == 0, "window block runs under sh (%s)" % r.stderr.strip())
f_ep, t_ep, query = r.stdout.split(" ", 2)
f_ep, t_ep = int(f_ep), int(t_ep)
check(t_ep == NOW - lag * 60, "window ends exactly LAG_MINUTES before now")
check(f_ep == t_ep - days * 86400, "window spans WINDOW_DAYS")
check(query.strip() == "after:%d before:%d" % (f_ep, t_ep),
      "Gmail query is epoch seconds: %r" % query.strip())
check(f_ep <= NOW - 86400 and NOW - t_ep < 3600,
      "window covers Health Mail Full's last-24h window up to the lag")

# ---- 3. fingerprint cache -----------------------------------------------
awk_prog = heredoc(cmd, "AWKEOF")
scan = heredoc(cmd, "SCANEOF")


def fp(mid):
    return hashlib.md5(mid.encode()).hexdigest()[:10]


with tempfile.TemporaryDirectory() as td:
    msgs = os.path.join(td, "messages")
    os.mkdir(msgs)
    open(os.path.join(td, "mid.awk"), "w").write(awk_prog)
    open(os.path.join(td, "scan.sh"), "w").write(scan)

    def put(key, body):
        open(os.path.join(msgs, key), "w", newline="").write(body)

    put("k1", "From: a\r\nMessage-ID: <one@example.test>\r\nSubject: x\r\n\r\nbody\r\n")
    # Folded header (Outlook/Exchange style): the value is on the next line.
    put("k2", "From: b\r\nMessage-ID:\r\n <two@example.test>\r\nSubject: y\r\n\r\nbody\r\n")
    # No Message-ID at all; a Message-ID-looking line in the BODY must not count.
    put("k3", "From: c\r\nSubject: z\r\n\r\nMessage-ID: <body@example.test>\r\n")
    keys = os.path.join(td, "keys")

    def run(key_list):
        open(keys, "w").write("\n".join(key_list) + "\n")
        r = sh("sh scan.sh", {
            "KEYS_CMD": "cat '%s'" % keys,
            "MSG_DIR": msgs,
            "CACHE": os.path.join(td, "cache.tsv"),
            "AWK_PROG": os.path.join(td, "mid.awk"),
            "LEGACY_CACHE": os.path.join(td, "no-legacy.tsv"),
        }, cwd=td)
        return r.returncode, sorted(r.stdout.split())

    rc, out = run(["k1", "k2", "k3", "k4"])  # k4: body file not there (yet)
    check(rc == 0, "cold scan exits 0")
    check(out == sorted([fp("one@example.test"), fp("two@example.test")]),
          "cold scan: plain + folded Message-ID, no-ID and body-only skipped")
    cache = open(os.path.join(td, "cache.tsv")).read()
    check("k3\t-" in cache, "key without Message-ID cached as '-'")
    check("k4" not in cache, "key with no body file is not cached (retried later)")

    # Warm run: change k1's body behind the cache's back. If the cache is
    # honoured the OLD fingerprint is still emitted, i.e. k1 was not re-parsed.
    put("k1", "Message-ID: <changed@example.test>\r\n\r\n")
    put("k4", "Message-ID: <four@example.test>\r\n\r\n")
    rc, out = run(["k1", "k2", "k3", "k4"])
    check(fp("one@example.test") in out and fp("changed@example.test") not in out,
          "warm scan does not re-parse cached bodies")
    check(fp("four@example.test") in out, "previously absent body is picked up")

    # k2 deleted from imapsql: it must drop out of the output AND the cache.
    rc, out = run(["k1", "k3", "k4"])
    check(fp("two@example.test") not in out, "deleted key no longer reported")
    check("k2\t" not in open(os.path.join(td, "cache.tsv")).read(),
          "deleted key pruned from the cache")

    rc, out = run([])
    check(rc != 0 and out == [], "empty key list is an error, not 'no mail'")

# ---- 3b. IO: the scan must not read the store (2026-11-18 oci-mail) -------
check(re.search(r'^max_active_runs:\s*1\s*$', raw, re.M) is not None,
      "max_active_runs: 1 (a cold scan outlasting 3h must not be doubled)")
check(re.search(r'CACHE=\$\{CACHE:-/data/', scan) is not None,
      "fingerprint cache defaults to maddy's data volume, not /tmp (lost on every recreate)")

# The parser must stop at the end of the headers. Checked on the program
# text: a timing test through a pipe is not portable (mawk, the CI runner's
# awk, drains the whole pipe regardless of `exit`), while production runs
# busybox awk on regular files, where `exit` stops the read. The behaviour
# (plain, folded, body-only Message-ID) is covered by the scan tests above.
check(re.search(r'^\s*/\^\\r\?\$/\s*\{\s*exit\s*\}', awk_prog, re.M) is not None,
      "Message-ID parser exits at the blank line ending the headers")
check(re.search(r'else\s*\{\s*exit\s*\}', awk_prog) is not None,
      "Message-ID parser exits at the header after a (folded) Message-ID")
check(not re.search(r'^\s*done\s*\{\s*next\s*\}', awk_prog, re.M),
      "no `done { next }`: that form reads every message to EOF")

with tempfile.TemporaryDirectory() as td:
    open(os.path.join(td, "mid.awk"), "w").write(awk_prog)
    # Legacy /tmp cache seeds the new location once, so moving it is not a cold scan.
    msgs = os.path.join(td, "messages"); os.mkdir(msgs)
    open(os.path.join(td, "scan.sh"), "w").write(scan)
    open(os.path.join(msgs, "k1"), "w").write("Message-ID: <new-body@example.test>\r\n\r\n")
    legacy = os.path.join(td, "legacy.tsv")
    open(legacy, "w").write("k1\t%s\n" % fp("from-legacy@example.test"))
    open(os.path.join(td, "keys"), "w").write("k1\n")
    env = {"KEYS_CMD": "cat '%s'" % os.path.join(td, "keys"), "MSG_DIR": msgs,
           "CACHE": os.path.join(td, "data-cache.tsv"), "LEGACY_CACHE": legacy,
           "AWK_PROG": os.path.join(td, "mid.awk")}
    r = sh("sh scan.sh", env, cwd=td)
    check(r.returncode == 0 and r.stdout.split() == [fp("from-legacy@example.test")],
          "empty new cache is seeded from the legacy /tmp cache (no re-parse)")
    open(legacy, "w").write("k1\t%s\n" % fp("stale@example.test"))
    r = sh("sh scan.sh", env, cwd=td)
    check(r.stdout.split() == [fp("from-legacy@example.test")],
          "a non-empty new cache is never overwritten by the legacy one")

# ---- 4. deliver(): retry only before handover ----------------------------
ns = {}
exec(between(cmd, "# >>> deliver\n", "# <<< deliver"), ns)
deliver, Deferred, is_permanent = ns["deliver"], ns["Deferred"], ns["is_permanent"]


class FakeSMTP:
    def __init__(self, log, mail=250, rcpt=250, data_exc=None):
        self.log, self._mail, self._rcpt, self._data_exc = log, mail, rcpt, data_exc

    def mail(self, rp):
        self.log.append("mail")
        return self._mail, b""

    def rcpt(self, to):
        self.log.append("rcpt")
        return self._rcpt, b""

    def data(self, data):
        self.log.append("data")
        if self._data_exc:
            raise self._data_exc
        return 250, b"ok"

    def quit(self):
        self.log.append("quit")

    def close(self):
        self.log.append("close")


def scenario(plan, **kw):
    """plan: list of per-connection behaviours (exception or FakeSMTP kwargs)."""
    log, sleeps, it = [], [], iter(plan)

    def connect():
        log.append("connect")
        step = next(it)
        if isinstance(step, BaseException):
            raise step
        return FakeSMTP(log, **step)

    try:
        res = deliver("rp@example.test", b"msg", connect=connect, sleep=sleeps.append)
    except Exception as e:  # noqa: BLE001
        res = e
    return res, log, sleeps


res, log, sleeps = scenario([{}])
check(res == 1 and log.count("data") == 1, "clean send: one connection, one DATA")

res, log, sleeps = scenario([ConnectionRefusedError(), TimeoutError(), {}])
check(res == 3 and log.count("data") == 1 and sleeps == [15, 30],
      "connect failures are retried with backoff, then one DATA")

res, log, sleeps = scenario([{"rcpt": 451}] * 3)
check(isinstance(res, Deferred) and log.count("connect") == 3 and "data" not in log,
      "RCPT 4xx retried up to the cap, then deferred, DATA never sent")

res, log, sleeps = scenario([{"rcpt": 550}])
check(isinstance(res, smtplib.SMTPRecipientsRefused) and is_permanent(res)
      and log.count("connect") == 1, "RCPT 5xx is permanent and not retried")

res, log, sleeps = scenario([{"data_exc": smtplib.SMTPServerDisconnected("timed out")}, {}])
check(isinstance(res, Deferred) and log.count("connect") == 1 and log.count("data") == 1,
      "timeout during DATA is NOT retried in-run (ambiguous: may be stored)")

res, log, sleeps = scenario([{"data_exc": smtplib.SMTPDataError(451, b"try later")}, {}])
check(isinstance(res, Deferred) and log.count("data") == 1, "DATA 4xx deferred, not retried")

res, log, sleeps = scenario([{"data_exc": smtplib.SMTPDataError(554, b"rejected")}])
check(isinstance(res, smtplib.SMTPDataError) and is_permanent(res), "DATA 5xx is permanent")

# ---- 5. verdict -----------------------------------------------------------
verdict = between(cmd, "# >>> verdict\n", "# <<< verdict")
with tempfile.TemporaryDirectory() as td:
    def judge(log_text, miss=5):
        open(os.path.join(td, "repair.log"), "w").write(log_text)
        r = sh(verdict + 'echo "$VERDICT"', {"TMP": td, "MISS": str(miss)})
        return r.stdout.strip()

    check(judge("REPAIRED 5 DEFERRED 0 FAILED 0\n") == "ok", "all repaired -> ok")
    check(judge("REPAIRED 8 DEFERRED 1 FAILED 0\n", 9) == "partial",
          "one transient miss among repairs -> partial (run stays green)")
    check(judge("REPAIRED 0 DEFERRED 3 FAILED 0\n", 3) == "failed",
          "nothing got through -> failed")
    check(judge("REPAIRED 4 DEFERRED 0 FAILED 1\n") == "failed", "permanent 5xx -> failed")
    check(judge("Traceback (most recent call last):\n") == "failed",
          "crashed repair run -> failed")

# ---- 6. Stalwart leg (reconcile-stalwart step) ----------------------------
check(re.search(r"continue_on:\s*\n\s*failure:\s*true", raw) is not None,
      "maddy step cannot block the Stalwart step (continue_on.failure)")
check(raw.index("name: reconcile-stalwart") > raw.index("name: reconcile\n"),
      "reconcile-stalwart is listed after reconcile (chain DAG: runs in order)")
check(not re.search(r"^\s*depends:", raw, re.M), "no depends: (rejected by chain-type DAGs)")
sw = raw[raw.index("name: reconcile-stalwart"):]
sw_cmd = command_block(sw)
check("STALWART_LOGIN_PASSWORD" in raw.split("steps:")[0], "JMAP password is a DAG env")

# JMAP fingerprints must equal the Gmail-side md5(Message-ID)[:10].
jm = {}
exec(between(sw_cmd, "# >>> jmap\n", "# <<< jmap").replace("ACCT", "ACCT_"), jm)
jm["ACCT_"] = "a1"
check(jm["fingerprints"](["one@example.test", " <two@example.test> ", "", None])
      == sorted([fp("one@example.test"), fp("two@example.test")]),
      "JMAP fingerprints match the Gmail-side md5(Message-ID)[:10]")

store = ["m%04d@example.test" % i for i in range(1203)]  # forces 3 pages of 500


def fake_call(mc):
    pos, limit = mc[0][1]["position"], mc[0][1]["limit"]
    ids = list(range(pos, min(pos + limit, len(store))))
    return [["Email/query", {"ids": ["e%d" % i for i in ids]}, "q"],
            ["Email/get", {"list": [{"messageId": [store[i]]} for i in ids]}, "g"]]


check(list(jm["run"](fake_call)) == store, "JMAP scan pages through the whole store")
check(list(jm["run"](fake_call, page=1203)) == store, "JMAP scan stops on an exactly-full page")

diff = between(sw_cmd, "# >>> stalwart-diff\n", "# <<< stalwart-diff")
with tempfile.TemporaryDirectory() as td:
    def w(n, lines):
        open(os.path.join(td, n), "w").write("".join(l + "\n" for l in lines))
    w("gmail.fps", ["a", "b", "c", "d"])      # Gmail has a..d
    w("stalwart.fps", ["a", "x"])             # Stalwart has a (+ older x)
    w("ex.fps", ["c"])                        # c was just re-injected via maddy
    r = sh(diff + "cat \"$TMP/missing.fps\"",
           {"TMP": td, "EXCL": os.path.join(td, "ex.fps")})
    check(r.stdout.split() == ["b", "d"],
          "Stalwart diff = Gmail - Stalwart - maddy-just-repaired (%r)" % r.stdout)

nsw = {}
exec(between(sw_cmd, "# >>> deliver-stalwart\n", "# <<< deliver-stalwart"), nsw)
check(nsw["SMTP_PORT"] == 2025 and nsw["SMTP_HOST"] == "10.0.0.3",
      "Stalwart repair talks to the MX ingest 10.0.0.3:2025, not maddy")
d2, D2 = nsw["deliver"], nsw["Deferred"]
lg = []
class FS(FakeSMTP):
    def ehlo(self, n):
        lg.append("ehlo")
check(d2("rp@x", b"m", connect=lambda: FS(lg), sleep=lambda s: None) == 1
      and lg.count("data") == 1, "Stalwart repair: clean send is one DATA")
lg.clear()
try:
    d2("rp@x", b"m", connect=lambda: FS(lg, data_exc=smtplib.SMTPServerDisconnected("t")),
       sleep=lambda s: None)
    res = None
except D2 as e:
    res = e
check(res is not None and lg.count("data") == 1,
      "Stalwart repair: failure during DATA is deferred, never retried in-run")

print()
if failures:
    print("FAILED (%d)" % len(failures))
    sys.exit(1)
print("PASS")
