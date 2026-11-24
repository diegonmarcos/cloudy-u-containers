#!/usr/bin/env python3
"""Parity harness for #1883: the Rust `maddy-sorter deliver` must answer exactly like the shell script it replaces
(mail-sieve-subset-delivery-time.sh, jq + awk + base64) on every generated (message, rules, env) combination:
same stdout bytes and same exit status. The shell script is the REFERENCE and is run unmodified.

  python3 test-deliver-parity.py <path-to-maddy-sorter> [--list]

Needs sh, jq, awk and base64 on the PATH (the CI runner has them). Exit 1 on the first set of differences, 2 when
the harness itself cannot run (a skipped parity run must never look green).
"""
import itertools
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SHELL_SCRIPT = os.path.join(HERE, "mail-sieve-subset-delivery-time.sh")

ACCOUNT = "me@example.org"


def b64(s):
    import base64
    return base64.b64encode(s.encode()).decode()


def msg(headers, body="body text\n", crlf=False, lead=""):
    nl = "\r\n" if crlf else "\n"
    text = lead + nl.join(headers) + nl + nl + body.replace("\n", nl)
    return text.encode("utf-8", "surrogateescape")


MESSAGES = {
    "plain_angle": msg(["From: Alice <alice@Example.COM>", "To: me@example.org", "Subject: Hello world"]),
    "bare_addr": msg(["From: bob@example.org", "To: me@example.org", "Subject: bare"]),
    "quoted_name": msg(['From: "Last, First" <f.l@sub.example.net>', "To: a@b.c, d@e.f", "Subject: Quoted"]),
    "angle_only": msg(["From: <x@y.z>", "Subject: angle only"]),
    "no_from": msg(["To: me@example.org", "Subject: no from header"]),
    "two_from_last_wins": msg(["From: first@one.example", "From: last@two.example", "Subject: two froms"]),
    "folded_from": msg(["From: Some Name", "  <folded@fold.example>", "Subject: folded from"]),
    "from_no_at": msg(["From: nobody", "Subject: no at sign"]),
    "from_semicolon": msg(["From: weird;@semi.example, other@x.y", "Subject: weird"]),
    "subject_b64": msg(["From: n@news.example", "Subject: =?UTF-8?B?" + b64("Invoice 42 ready") + "?="]),
    "subject_b64_utf8": msg(["From: n@news.example", "Subject: =?utf-8?b?" + b64("Grüße ☃ weekly") + "?="]),
    "subject_q": msg(["From: n@news.example", "Subject: =?utf-8?Q?Re=3A_Your_order_=2312345?="]),
    "subject_q_latin1": msg(["From: n@news.example", "Subject: =?iso-8859-1?Q?caf=E9_menu?="]),
    "subject_two_words": msg(["From: n@news.example", "Subject: =?UTF-8?B?" + b64("Hello ") + "?= =?UTF-8?B?" + b64("World") + "?="]),
    "subject_mixed": msg(["From: n@news.example", "Subject: Re: =?UTF-8?B?" + b64("sale") + "?= now on"]),
    "subject_bad_b64": msg(["From: n@news.example", "Subject: =?UTF-8?B?!!!notbase64!!!?= tail"]),
    "subject_short_b64": msg(["From: n@news.example", "Subject: =?UTF-8?B?QUJDRA?= x"]),
    "subject_padded": msg(["From: n@news.example", "Subject: =?UTF-8?B?QQ==?= =?UTF-8?B?QUI=?="]),
    "subject_b64_newline": msg(["From: n@news.example", "Subject: =?UTF-8?B?" + b64("line1\nline2") + "?="]),
    "subject_folded": msg(["From: n@news.example", "Subject: part one", "  part two", "\tpart three"]),
    "subject_empty": msg(["From: n@news.example", "Subject:"]),
    "no_subject": msg(["From: n@news.example"]),
    "list_headers": msg(["From: dev@lists.example.org", "List-Id: <dev.lists.example.org>", "Subject: [dev] patch", "Cc: someone@else.example", "Bcc: hidden@else.example"]),
    "reply_to": msg(["From: a@b.example", "Reply-To: support@vendor.example", "Subject: ticket"]),
    "custom_headers": msg(["From: ci@github.com", "X-GitHub-Reason: mention", "X-Mailer: Foo-Mailer 1.0", "X-Dup: first value", "X-Dup: second value", "Subject: build"]),
    "folded_custom": msg(["From: a@b.example", "X-Folded: alpha", "  beta needle", "Subject: s"]),
    "self_sent": msg(["From: Me <ME@Example.org>", "To: other@x.y", "Subject: note to self"]),
    "crlf_basic": msg(["From: Alice <alice@example.com>", "To: me@example.org", "Subject: crlf"], crlf=True),
    "crlf_folded": msg(["From: Alice", " <alice@example.com>", "Subject: =?UTF-8?B?" + b64("crlf subject") + "?="], crlf=True),
    "leading_blank_lines": msg(["From: lead@lead.example", "Subject: leading blanks"], lead="\n\n"),
    "headers_only": ("From: only@headers.example\nSubject: headers only").encode(),
    "headers_only_nl": ("From: only@headers.example\nSubject: headers only\n").encode(),
    "multi_blank_then_body": ("From: a@b.example\nSubject: s\n\n\n\nbody: From: fake@evil.example\n").encode(),
    "body_has_headers": ("From: real@real.example\n\nSubject: in body\nList-Id: <body.example>\n").encode(),
    "empty": b"",
    "tab_continuation": msg(["From: t@tab.example", "Subject: one", "\ttwo"]),
    "uppercase_names": msg(["FROM: Upper <up@upper.example>", "SUBJECT: UPPER SUBJECT", "LIST-ID: <Upper.List>"]),
    "x_regex_target": msg(["From: a@b.example", "X-Spam-Score: 7.5", "X-Priority: 1 (Highest)", "Subject: s"]),
}

SENDER = "envelope@sender.example"
RCPT = "me@example.org"


def doc(rules, **extra):
    d = {"schema_version": 2, "account": ACCOUNT, "routing_default": "Others", "rules": rules}
    d.update(extra)
    return d


def r(i, when, folder=None, flags=None, axis=None, priority=None):
    o = {"id": f"r{i}", "when": when}
    if folder is not None:
        o["folder"] = folder
    if flags is not None:
        o["flags"] = flags
    if axis is not None:
        o["axis"] = axis
    return o


RULESETS = {
    "sender_axis": doc([
        r(1, {"type": "from_domain", "values": ["example.com", "News.Example"]}, "Fz Example", ["$a"]),
        r(2, {"type": "from_domain_suffix", "values": [".example.net", ".github.com"]}, "Fz Suffix", ["\\Flagged"]),
        r(3, {"type": "from_address", "values": ["bob@example.org"]}, "Fz Bob"),
        r(4, {"type": "from_domain", "values": ["news.example"]}, "Fz News"),
    ], delivery_strategy="split"),
    "split_flags_union": doc([
        r(1, {"type": "subject_contains", "values": ["invoice", "weekly"]}, "Billing", ["\\Seen", "$bill"]),
        r(2, {"type": "to_contains", "values": ["me@example.org"]}, None, ["$tome", "\\Seen"]),
        r(3, {"type": "reply_to_contains", "values": ["vendor.example"]}, "Vendors"),
        r(4, {"type": "list_id_contains", "values": ["lists.example.org", "upper.list"]}, "Lists", ["$list"]),
    ], delivery_strategy="split", inbox_copy_flags=["\\Seen"]),
    "unified_default": doc([
        r(1, {"type": "from_domain", "values": ["example.com"]}, "Fz A", ["$a"]),
        r(2, {"type": "has_cc"}, None, ["$cc"]),
    ]),
    "unified_custom_inbox_flags": doc([
        r(1, {"type": "has_bcc"}, None, ["$bcc"]),
        r(2, {"type": "list_header"}, None, ["$list", "\\Seen"]),
    ], inbox_copy_flags=["\\Seen", "$archive"]),
    "headers_preds": doc([
        r(1, {"type": "header_contains", "header": "X-GitHub-Reason", "values": ["MENTION"]}, "Gh", ["$gh"]),
        r(2, {"type": "header_exists", "header": "X-Mailer"}, "Mailer"),
        r(3, {"type": "header_regex", "header": "X-Priority", "regex": "^1 \\("}, "Prio", ["$p1"]),
        r(4, {"type": "header_contains", "header": "X-Dup", "values": ["second"]}, "DupSecond"),
        r(5, {"type": "header_contains", "header": "X-Dup", "values": ["first"]}, "DupFirst"),
        r(6, {"type": "header_contains", "header": "X-Folded", "values": ["needle"]}, "Folded"),
        r(7, {"type": "header_regex", "header": "X-Spam-Score", "regex": "^[5-9]\\.\\d"}, "Spam", ["$spam"]),
        r(8, {"type": "header_exists", "header": "List-Id"}, "AnyList"),
    ], delivery_strategy="split"),
    "combinators": doc([
        r(1, {"all_of": [{"type": "from_domain", "values": ["example.com"]}, {"not": {"type": "has_cc"}}]}, "AllOf", ["$all"]),
        r(2, {"any_of": [{"type": "subject_contains", "values": ["hello"]}, {"type": "from_address", "values": ["bob@example.org"]}]}, "AnyOf"),
        r(3, {"not": {"any_of": [{"type": "from_domain", "values": ["example.com", "example.org", "news.example"]}]}}, "NotKnown", ["$unknown"]),
        r(4, {"all_of": []}, "EmptyAll", ["$emptyall"]),
        r(5, {"any_of": []}, "EmptyAny"),
        r(6, {"self_sent": True, "type": "self_sent"}, "Self", ["\\Seen"]),
    ], delivery_strategy="split"),
    "unknown_predicate": doc([
        r(1, {"type": "size_over", "values": [1000]}, "Big"),
        r(2, {"type": "from_domain", "values": ["example.com"]}, "A"),
        r(3, {"type": "body_contains", "values": ["x"]}, "Body"),
    ], delivery_strategy="split"),
    "axis_auth_ignored": doc([
        r(1, {"type": "from_domain", "values": ["example.com"]}, "AuthFolder", ["$auth"], axis="auth"),
        r(2, {"type": "from_domain", "values": ["example.com"]}, "SenderFolder", ["$sender"], axis="sender"),
        r(3, {"type": "from_domain", "values": ["example.com"]}, "NoAxis", ["$noaxis"]),
    ], delivery_strategy="split"),
    "no_default_no_rules": {"schema_version": 2, "account": ACCOUNT, "rules": []},
    "empty_default": doc([r(1, {"type": "from_domain", "values": ["nomatch.invalid"]}, "X")], routing_default="", delivery_strategy="split"),
    "invalid_regex": doc([r(1, {"type": "header_regex", "header": "X-Priority", "regex": "("}, "Bad")], delivery_strategy="split"),
    "bad_header_name_regex": doc([r(1, {"type": "header_exists", "header": "X-(Bad"}, "Bad")], delivery_strategy="split"),
    "missing_values": doc([r(1, {"type": "from_domain"}, "NoValues")], delivery_strategy="split"),
    "schema_1": {"schema_version": 1, "account": ACCOUNT, "routing_default": "Others", "rules": [r(1, {"type": "from_domain", "values": ["example.com"]}, "A")]},
    "schema_string_2": {"schema_version": "2", "account": ACCOUNT, "routing_default": "Others", "rules": [r(1, {"type": "from_domain", "values": ["example.com"]}, "A")]},
    "schema_float_2": None,  # written raw below: schema_version 2.0
    "schema_missing": {"account": ACCOUNT, "rules": []},
}
RAW_RULESETS = {
    "schema_float_2": '{"schema_version": 2.0, "account": "me@example.org", "routing_default": "Others", "delivery_strategy": "split", "rules": [{"id":"r1","when":{"type":"from_domain","values":["example.com"]},"folder":"A"}]}',
    "not_json": "this is not json {",
}
ENVS = [None, "split", "unified-inbox", ""]


def run_shell(rules_path, env_strategy, message):
    env = dict(os.environ, RULES_PATH=rules_path)
    env.pop("MAIL_SIEVE_STRATEGY", None)
    env.pop("MAIL_SIEVE_DEBUG", None)
    if env_strategy is not None:
        env["MAIL_SIEVE_STRATEGY"] = env_strategy
    p = subprocess.run(["sh", SHELL_SCRIPT, ACCOUNT, SENDER, RCPT, "ignored subject"], input=message, capture_output=True, env=env)
    return p.returncode, p.stdout


def run_rust(binary, rules_path, env_strategy, message):
    env = dict(os.environ, RULES_PATH=rules_path)
    env.pop("MAIL_SIEVE_STRATEGY", None)
    env.pop("MAIL_SIEVE_DEBUG", None)
    if env_strategy is not None:
        env["MAIL_SIEVE_STRATEGY"] = env_strategy
    p = subprocess.run([binary, "deliver", ACCOUNT, SENDER, RCPT, "ignored subject"], input=message, capture_output=True, env=env)
    return p.returncode, p.stdout


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    binary = sys.argv[1]
    list_only = "--list" in sys.argv
    for tool in ("sh", "jq", "awk", "base64"):
        if subprocess.run(["which", tool], capture_output=True).returncode != 0:
            print(f"harness cannot run: {tool} not found")
            return 2
    if not list_only and not os.path.exists(binary):
        print(f"harness cannot run: {binary} does not exist")
        return 2
    tmp = tempfile.mkdtemp(prefix="deliver-parity-")
    paths = {}
    for name, d in RULESETS.items():
        if d is None:
            continue
        paths[name] = os.path.join(tmp, name + ".json")
        with open(paths[name], "w") as f:
            json.dump(d, f)
    for name, raw in RAW_RULESETS.items():
        paths[name] = os.path.join(tmp, name + ".json")
        with open(paths[name], "w") as f:
            f.write(raw)
    paths["missing_file"] = os.path.join(tmp, "does-not-exist.json")

    total = 0
    diffs = []
    outputs = {}
    for (rname, rpath), (mname, m), env in itertools.product(paths.items(), MESSAGES.items(), ENVS):
        sh = run_shell(rpath, env, m)
        outputs[(rname, mname, env)] = sh
        total += 1
        if list_only:
            continue
        rs = run_rust(binary, rpath, env, m)
        if sh != rs:
            diffs.append((rname, mname, env, sh, rs))
    if list_only:
        for k, v in outputs.items():
            print(k, v)
        return 0
    print(f"deliver parity: {total} (rules x message x env) combinations compared")
    # The corpus must actually exercise routing, otherwise equality proves nothing.
    distinct = {v for v in outputs.values()}
    print(f"distinct reference outputs: {len(distinct)}")
    if len(distinct) < 25:
        print("corpus too weak: fewer than 25 distinct outputs")
        return 2
    if diffs:
        for rname, mname, env, sh, rs in diffs[:25]:
            print(f"DIFF rules={rname} message={mname} env={env!r}\n  shell: {sh}\n  rust : {rs}")
        print(f"{len(diffs)} difference(s)")
        return 1
    print("deliver parity: identical")
    return 0


if __name__ == "__main__":
    sys.exit(main())
