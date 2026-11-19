#!/usr/bin/env python3
"""#1820 tester: ops_docker-prune removes superseded fleet images safely.
P1 runs daily; P2 superseded step present; P3 limited to ghcr.io/diegonmarcos/* and tag <none>;
P4 skips any image a container (running or stopped) references; P5 never forces, never prunes -a,
never prunes volumes; P6 the step actually executes: simulated on a fake docker CLI."""
import os, re, subprocess, sys, tempfile, textwrap
here = os.path.dirname(os.path.abspath(__file__))
y = open(os.path.join(here, "ops_docker-prune.yaml")).read()
fails = 0
def check(name, cond):
    global fails
    print(("ok   " if cond else "FAIL ") + name); fails += 0 if cond else 1
check("P1 daily schedule", 'schedule: "0 4 * * *"' in y)
check("P2 superseded step present", "superseded fleet images removed" in y)
check("P3 ghcr fleet repo + <none> tag only", 'reference=ghcr.io/diegonmarcos/*' in y and '\\"<none>\\"' in y)
check("P4 skips images a container references", "docker ps -a -q --filter ancestor=$id" in y)
code = "\n".join(l for l in y.splitlines() if not l.lstrip().startswith("#"))
check("P5 no rmi -f, no prune -a, no volume prune (command lines)", not re.search(r"rmi -f|prune -a|prune -af|volume prune", code))
# P6: extract the remote one-liner and run it against a fake docker
m = re.search(r"SUPERSEDED=\$\(\$SSH \"\$USER@\$IP\" '(.*?)' 2>/dev/null", y)
check("P6a remote command extractable", bool(m))
if m:
    cmd = m.group(1).replace('\\\\', '\\')
    d = tempfile.mkdtemp()
    fake = textwrap.dedent('''\
        #!/bin/sh
        case "$1" in
          images) printf '%s\\n' '<none> aaa111' '<none> bbb222' 'latest ccc333' ;;
          ps) [ "$5" = "ancestor=bbb222" ] && echo c1 ;;
          rmi) echo "$2" >> "$LOG" ;;
        esac
    ''')
    open(os.path.join(d, "docker"), "w").write(fake); os.chmod(os.path.join(d, "docker"), 0o755)
    log = os.path.join(d, "rmi.log")
    out = subprocess.run(["sh", "-c", cmd], env={"PATH": d + ":/usr/bin:/bin", "LOG": log}, capture_output=True, text=True).stdout
    removed = open(log).read().split() if os.path.exists(log) else []
    check("P6b removes only the unreferenced <none> image (aaa111)", removed == ["aaa111"])
    check("P6c reports the count", "superseded fleet images removed: 1" in out)
sys.exit(1 if fails else 0)
