"""
#1683: after a restart google-workspace-mcp exited with "Port 3104 is already in use" although
nothing listened. The previous process's closed connections were in TIME_WAIT (host networking,
TCP health checks) and the start-up pre-check bound a plain socket without SO_REUSEADDR. This
reproduces TIME_WAIT on a loopback port and checks that the pre-check passes there, as uvicorn's
own bind does, and still fails on a live listener.
"""
import os
import socket
import unittest

try:
    from . import _env  # noqa: F401
except ImportError:
    import _env  # noqa: F401

from core.port_check import port_is_free

CODE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def leave_time_wait():
    """Listen, accept one connection, close it SERVER side first (the side that closes first
    holds TIME_WAIT on the listening port), then stop listening. Returns the port."""
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    port = srv.getsockname()[1]
    cli = socket.create_connection(("127.0.0.1", port))
    conn, _ = srv.accept()
    conn.close()
    cli.recv(1)  # see the FIN, so the server side completes its close into TIME_WAIT
    cli.close()
    srv.close()
    return port


class PortCheckTimeWait(unittest.TestCase):
    def test_time_wait_reproduces_the_old_failure(self):
        port = leave_time_wait()
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            with self.assertRaises(OSError, msg="plain bind should fail under TIME_WAIT (the old check)"):
                s.bind(("127.0.0.1", port))

    def test_time_wait_is_not_in_use(self):
        port = leave_time_wait()
        free, err = port_is_free("127.0.0.1", port)
        self.assertTrue(free, f"a restart must come up on the first try, got {err}")

    def test_live_listener_is_in_use(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as srv:
            srv.bind(("127.0.0.1", 0))
            srv.listen(1)
            free, err = port_is_free("127.0.0.1", srv.getsockname()[1])
            self.assertFalse(free)
            self.assertIsInstance(err, OSError)

    def test_startup_paths_use_the_shared_check(self):
        for rel in ("main.py", os.path.join("auth", "oauth_callback_server.py")):
            with open(os.path.join(CODE, rel), encoding="utf-8") as f:
                src = f.read()
            self.assertIn("port_is_free(", src, f"{rel} must use core.port_check")
            self.assertNotIn("s.bind((host, port))", src, f"{rel} still has a plain pre-bind")
            self.assertNotIn("s.bind((hostname, self.port))", src, f"{rel} still has a plain pre-bind")


if __name__ == "__main__":
    unittest.main()
