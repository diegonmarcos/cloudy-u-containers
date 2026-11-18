#!/usr/bin/env python3
# #1802: apply-delivery-ledger.py against a fake Stalwart JMAP registry (loopback
# only). Pins: the exact WebHook/MtaHook payloads sent, create-once then no-op,
# restart=1 only when the webhook is created, and never a destroy.
import json, os, subprocess, sys, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "templates", "apply-delivery-ledger.py.tpl")
BUILD = json.load(open(os.path.join(HERE, "build.json")))
CFG = BUILD["delivery_ledger"]

STORE = {"WebHook": {}, "MtaHook": {}}
CALLS = []

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, obj):
        b = json.dumps(obj).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        assert self.path == "/jmap/session"
        self._send({"primaryAccounts": {"urn:stalwart:jmap": "admin1"}, "accounts": {"admin1": {}}})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        name, args, cid = body["methodCalls"][0]
        CALLS.append((name, args))
        typ, op = name[2:].split("/")
        if typ == "Action":
            return self._send({"methodResponses": [[name, {"created": {"a": {"id": "x"}}}, cid]]})
        st = STORE[typ]
        if op == "get":
            return self._send({"methodResponses": [[name, {"list": [dict(v, id=k) for k, v in st.items()]}, cid]]})
        assert op == "set" and "destroy" not in args, "helper must never destroy"
        res = {}
        for k, v in (args.get("create") or {}).items():
            st[f"{typ}{len(st)}"] = v; res.setdefault("created", {})[k] = {"id": f"{typ}{len(st)-1}"}
        for k, v in (args.get("update") or {}).items():
            st[k].update(v); res.setdefault("updated", {})[k] = None
        self._send({"methodResponses": [[name, res, cid]]})

srv = HTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_port}"
cfg = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False); json.dump(CFG, cfg); cfg.close()

def run():
    p = subprocess.run([sys.executable, HELPER, cfg.name, base, "admin:pw"], capture_output=True, text=True, timeout=30)
    assert p.returncode == 0, p.stdout + p.stderr
    return [l for l in p.stdout.splitlines() if l.startswith("[ledger] RESULT")][0]

fails = 0
def check(cond, msg):
    global fails
    print(("ok   " if cond else "FAIL ") + msg)
    fails += 0 if cond else 1

r1 = run()
check("changed=1 restart=1 webhook=created mtahook=created" in r1, f"first run creates both and asks for a restart: {r1}")
wh = next(iter(STORE["WebHook"].values())); mh = next(iter(STORE["MtaHook"].values()))
check(wh["url"] == CFG["webhook_url"] and wh["eventsPolicy"] == "include", "webhook url + include policy")
check(wh["events"] == {e: True for e in CFG["events"]}, "webhook events are the declared set, as a {name:true} map")
check(mh["tempFailOnError"] is False, "MtaHook never tempfails mail when the ledger is down")
check(mh["stages"] == {"data": True}, "MtaHook runs at DATA only")
check(mh["enable"] == {"match": {}, "else": CFG["mta_hook_enable"]}, "MtaHook enable expression")
n_before = len(CALLS)
r2 = run()
check("changed=0 restart=0 webhook=present mtahook=present" in r2, f"second run is a no-op: {r2}")
check(not any(n.endswith("/set") for n, _ in CALLS[n_before:]), "no write and no reload on a no-op run")
STORE["MtaHook"][next(iter(STORE["MtaHook"]))]["timeout"] = 1
r3 = run()
check("changed=1 restart=0 webhook=present mtahook=updated" in r3, f"drifted MtaHook is updated without a restart: {r3}")
srv.shutdown(); os.unlink(cfg.name)
print(f"{'PASS' if not fails else 'FAIL'}: {fails} failure(s)")
sys.exit(1 if fails else 0)
