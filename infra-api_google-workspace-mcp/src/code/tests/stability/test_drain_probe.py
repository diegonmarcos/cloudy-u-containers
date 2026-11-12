"""
#1659: a redeploy must not kill long jobs. src/drain-probe.sh is what the ship engine pipes into
the container before it recreates it; this runs the real script against planted /proc entries and
checks the server side of the contract (jobs register themselves, new jobs are refused on hold).
"""
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest

try:
    from . import _env
except ImportError:
    import _env

from core import streaming
from gdrive import unzip_engine as ue

SERVICE = os.path.abspath(os.path.join(_env.CODE, "..", ".."))
PROBE = os.path.join(SERVICE, "src", "drain-probe.sh")


class Sandbox:
    def __init__(self):
        self.root = tempfile.mkdtemp(prefix="probe-")
        self.proc = os.path.join(self.root, "proc")
        self.tmp = os.path.join(self.root, "tmp")
        os.makedirs(self.proc)
        os.makedirs(self.tmp)

    def process(self, pid, argv, start="1000"):
        d = os.path.join(self.proc, str(pid))
        os.makedirs(d)
        with open(os.path.join(d, "cmdline"), "wb") as fh:
            fh.write(b"\0".join(a.encode() for a in argv) + b"\0")
        with open(os.path.join(d, "stat"), "w") as fh:
            fh.write(f"{pid} (python3 (x) y) S " + " ".join(["0"] * 18) + f" {start} 0 0\n")

    def run(self, *args):
        with open(PROBE) as script:  # piped on stdin, exactly as the drain waiter does
            r = subprocess.run(["sh", "-s", "--", *args], stdin=script, capture_output=True, text=True,
                               env={"PATH": os.environ["PATH"], "PROBE_PROC": self.proc, "WORKSPACE_MCP_TMP_DIR": self.tmp})
        return r.returncode, r.stdout.strip().splitlines(), r.stderr

    def server(self):
        self.process(1, ["/sbin/docker-init", "--", "uv", "run", "--no-sync", "main.py", "--transport", "streamable-http"])
        self.process(7, ["uv", "run", "--no-sync", "main.py", "--transport", "streamable-http", "--tool-tier", "complete"])
        self.process(10, ["/app/.venv/bin/python3", "main.py", "--transport", "streamable-http", "--tool-tier", "complete"], start="4242")


class DrainProbe(unittest.TestCase):
    def setUp(self):
        self.sb = Sandbox()
        self.sb.server()

    def tearDown(self):
        shutil.rmtree(self.sb.root, ignore_errors=True)

    def test_an_idle_server_is_drained(self):
        self.assertEqual(self.sb.run("list"), (0, [], ""))

    def test_the_2026_11_11_backup_scripts_are_seen(self):
        # the exact process list of the live container while the gate was closed
        self.sb.process(258, ["sh", "-c", "cd /app && /app/.venv/bin/python /tmp/gitbk.py > /tmp/gitbk.log 2>&1"])
        self.sb.process(264, ["/app/.venv/bin/python", "/tmp/gitbk.py"])
        rc, lines, _ = self.sb.run("list")
        self.assertEqual(rc, 0)
        self.assertTrue(any(ln.startswith("process pid=264 ") and "/tmp/gitbk.py" in ln for ln in lines), lines)
        self.assertFalse(any("pid=10 " in ln or "pid=7 " in ln or "pid=1 " in ln for ln in lines), "the server itself is not a job")

    def test_a_healthcheck_curl_is_not_a_job(self):
        self.sb.process(900, ["curl", "-f", "http://10.0.0.6:3104/health"])
        self.assertEqual(self.sb.run("list")[1], [])

    def test_a_registered_unzip_job_is_seen_while_its_server_lives(self):
        d = os.path.join(self.sb.tmp, "unzip-0123456789ab")
        os.makedirs(d)
        with open(os.path.join(d, "ACTIVE"), "w") as fh:
            fh.write("10 4242\n")
        self.assertEqual(self.sb.run("list")[1], ["unzip-job id=0123456789ab server_pid=10"])

    def test_a_stale_registration_is_not_a_job(self):
        d = os.path.join(self.sb.tmp, "unzip-0123456789ab")
        os.makedirs(d)
        with open(os.path.join(d, "ACTIVE"), "w") as fh:
            fh.write("10 9999\n")  # same pid, another process: the server was restarted
        self.assertEqual(self.sb.run("list")[1], [])
        with open(os.path.join(d, "ACTIVE"), "w") as fh:
            fh.write("555 4242\n")  # pid gone
        self.assertEqual(self.sb.run("list")[1], [])

    def test_hold_closes_admission_then_lists_and_release_reopens(self):
        self.sb.process(264, ["/app/.venv/bin/python", "/tmp/tk.py"])
        rc, lines, _ = self.sb.run("hold", "1999999999")
        self.assertEqual(rc, 0)
        self.assertEqual(len(lines), 1, "hold must also list: the waiter reads its output as the live set")
        with open(os.path.join(self.sb.tmp, ".deploy-hold")) as fh:
            self.assertEqual(fh.read().strip(), "1999999999")
        self.assertEqual(self.sb.run("release")[0], 0)
        self.assertFalse(os.path.exists(os.path.join(self.sb.tmp, ".deploy-hold")))

    def test_hold_works_in_a_container_that_has_no_temp_dir_yet(self):
        shutil.rmtree(self.sb.tmp)  # the image that predates this change never created it
        self.assertEqual(self.sb.run("hold", "1999999999")[0], 0)
        self.assertTrue(os.path.exists(os.path.join(self.sb.tmp, ".deploy-hold")))

    def test_bad_usage(self):
        self.assertEqual(self.sb.run("bogus")[0], 64)
        self.assertNotEqual(self.sb.run("hold")[0], 0)


class ServerSide(unittest.TestCase):
    def setUp(self):
        ue._jobs.clear()
        self.hold = streaming.tmp_dir() / ".deploy-hold"
        self.gate = __import__("threading").Event()

    def tearDown(self):
        self.gate.set()
        if self.hold.exists():
            self.hold.unlink()

    def _kw(self):
        class Blocked:
            def files(inner):
                self.gate.wait(10)
                raise RuntimeError("stop")
        return dict(zip_file_id="z", service_factory=Blocked)

    def test_a_running_job_registers_itself_with_the_real_probe(self):
        job = ue.start_job(**self._kw())
        active = os.path.join(job._work_dir, "ACTIVE")
        self.assertTrue(os.path.exists(active), "registered before start_job returns")
        with open(active) as fh:
            pid, start = fh.read().split()
        self.assertEqual(int(pid), os.getpid())
        with open(PROBE) as script:
            out = subprocess.run(["sh", "-s", "--", "list"], stdin=script, capture_output=True, text=True,
                                 env={"PATH": os.environ["PATH"], "WORKSPACE_MCP_TMP_DIR": str(streaming.tmp_dir())}).stdout
        self.assertIn(f"unzip-job id={job.job_id} server_pid={os.getpid()}", out, "the real probe on the real /proc")
        self.gate.set()
        end = time.time() + 10
        while not job.finished and time.time() < end:
            time.sleep(0.01)
        self.assertFalse(os.path.exists(active), "a finished job is no longer live")

    def test_new_jobs_are_refused_while_a_redeploy_holds_admission(self):
        self.hold.write_text(str(int(time.time()) + 300))
        with self.assertRaises(ue.UnzipError) as cm:
            ue.start_job(**self._kw())
        self.assertIn("redeploy", str(cm.exception))
        self.assertEqual(ue.list_jobs(), [])
        self.hold.write_text(str(int(time.time()) - 1))  # an expired lease reopens by itself
        job = ue.start_job(**self._kw())
        self.gate.set()
        self.assertIsNotNone(job.job_id)


class Declaration(unittest.TestCase):
    def test_build_json_declares_the_drain_the_engine_needs(self):
        with open(os.path.join(SERVICE, "build.json")) as fh:
            b = json.load(fh)
        drain = b["deploy"]["drain"]
        self.assertTrue(os.path.getsize(os.path.join(SERVICE, drain["probe"])) > 0, "the engine refuses an empty probe")
        self.assertIsInstance(drain["max_wait_seconds"], int)
        self.assertIsInstance(drain["poll_seconds"], int)
        self.assertGreaterEqual(drain["max_wait_seconds"], 6 * 3600, "an unzip of a large Takeout takes hours")
        with open(os.path.join(SERVICE, "src", "Dockerfile.native")) as fh:
            self.assertIn(f"USER {drain['exec_user']}", fh.read(), "the probe runs as the container's user")
        self.assertNotIn("post_hook", b.get("compose", {}), "deploy.drain with compose.post_hook is refused by the engine")


if __name__ == "__main__":
    unittest.main()
