#!/usr/bin/env python3
"""Reference driver for the Go parity harness (#1880). Loads the ORIGINAL ntfy-bridge.py unmodified (path from
NTFY_BRIDGE_PY or the sibling service directory) and runs its real functions against servers the Go test provides.
Needs: pip install requests websocket-client Pillow."""
import importlib.util
import json
import os
import sys

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.environ.get("NTFY_BRIDGE_PY", os.path.join(HERE, "..", "..", "..", "..", "user-comm_chat-mattermost", "src", "code", "ntfy-bridge.py"))


def load(env):
    for k, v in env.items():
        os.environ[k] = v
    spec = importlib.util.spec_from_file_location("bridge_py", PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    cmd = sys.argv[1]
    req = json.loads(sys.argv[2])
    m = load(req.get("env", {}))
    if cmd == "bootstrap":
        class NoServer:
            def __init__(self, *a, **k):
                pass

            def serve_forever(self):
                pass

        class NoThread:
            def __init__(self, *a, **k):
                pass

            def start(self):
                pass

        m.time.sleep = lambda *_: None
        m.HTTPServer = NoServer
        m.threading.Thread = NoThread

        def stop(*_a, **_k):
            raise SystemExit(0)

        m.subscribe_and_bridge = stop
        try:
            m.main()
        except SystemExit:
            pass
        print("ok")
    elif cmd == "funcs":
        out = {
            "sanitize": [m.sanitize_channel(t) for t in req["topics"]],
            "format": [m.format_message(x) for x in req["messages"]],
        }
        json.dump(out, sys.stdout)
    elif cmd == "bridge":
        m.NTFY_URL = req["ntfy"]
        m.TOPICS = req["topics"]
        m.subscribe_and_bridge(req["webhook"])
        print("ok")
    elif cmd == "c3-serve":
        from http.server import HTTPServer
        m.C3_API_URL = req["c3"]
        m.C3_API_TOKEN = req.get("token", "")
        srv = HTTPServer(("127.0.0.1", req["port"]), m.C3CommandHandler)
        print("ready", flush=True)
        srv.serve_forever()
    else:
        raise SystemExit("unknown command " + cmd)


if __name__ == "__main__":
    main()
