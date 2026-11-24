#!/usr/bin/env python3
"""Reference driver for the Go parity harness. Loads the ORIGINAL Python sidecars (infra-obs_ntfy/src/code) unmodified and
answers one JSON request on stdin with one JSON document on stdout. The Go port must produce the same data."""
import importlib.util
import sys
sys.dont_write_bytecode = True
import json
import os
import sys

CODE = os.environ.get("NTFY_PY_CODE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "infra-obs_ntfy", "src", "code"))


def load(fname, name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(CODE, fname))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    # The sidecar modules print diagnostics to stdout; the JSON answer goes to the real stdout, their chatter to stderr.
    real_out = sys.stdout
    sys.stdout = sys.stderr
    cmd = sys.argv[1]
    req = json.load(sys.stdin) if cmd != "rss-serve" else json.loads(sys.argv[2])
    if cmd == "broker":
        nb = load("notify-broker.py", "nb")
        state, out = {}, []
        for st in req["steps"]:
            actions, state = nb.decide(st["event"], req["policy"], state, st["now"])
            out.append({"actions": actions, "state": state})
        json.dump(out, real_out)
    elif cmd == "digest":
        nd = load("notify-digest.py", "nd")
        json.dump([nd.summarize(c["records"], c["now"], c["weekly"]) for c in req["cases"]], real_out)
    elif cmd == "history":
        nd = load("notify-digest.py", "nd")
        json.dump(nd.read_history(req["path"], req["since"]), real_out)
    elif cmd == "scanner":
        ts = load("topic-scanner.py", "ts")
        ts.DB_PATH = req["db"]
        t = ts.scan_topics()
        json.dump({"topics": t, "dumped": json.dumps({"topics": t, "updated": "U"})}, real_out)
    elif cmd == "ghrss":
        g = load("github-rss-to-ntfy.py", "g")
        out = {"classify": [list(g.classify_event(t)) for t in req["titles"]],
               "strip": [g.strip_html(t) for t in req["html"]],
               "parse": [g.parse_atom_feed(x) for x in req["feeds"]]}
        json.dump(out, real_out)
    elif cmd == "syslog":
        s = load("syslog-to-ntfy.py", "s")
        out = []
        for line in req["lines"]:
            a = s.parse_sauron_alert(line)
            if a is None:
                out.append(None)
                continue
            vm = a.get("vm", "unknown")
            ts = a.get("ts", "")
            ad = a.get("alert", {})
            rule = ad.get("rule", "Unknown")
            path = ad.get("path", "")
            out.append({"title": f"🔴 Sauron Alert: {rule}", "message": f"VM: {vm}\nPath: {path}\nTime: {ts}"})
        json.dump(out, real_out, ensure_ascii=False)
    elif cmd == "rss-serve":
        from http.server import HTTPServer
        r = load("rss-gateway.py", "r")
        r.PROFILES_CONFIG = req["profiles"]
        r.CHANNELS_CONFIG = req["channels"]
        r.NTFY_INTERNAL = req["ntfy"]
        srv = HTTPServer(("127.0.0.1", req["port"]), r.Handler)
        print("ready", file=real_out, flush=True)
        srv.serve_forever()
    else:
        raise SystemExit("unknown command " + cmd)


if __name__ == "__main__":
    main()
