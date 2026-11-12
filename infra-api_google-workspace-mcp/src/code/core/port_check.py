"""Is a TCP port free to LISTEN on? (#1683)

The start-up check used to bind a plain socket. Without SO_REUSEADDR, Linux refuses that
bind while the previous process's closed connections on the port are still in TIME_WAIT
(up to 60 s). google-workspace-mcp runs with host networking and is health-checked over
TCP, so right after a restart the port always had TIME_WAIT entries: the check reported
"Port 3104 is already in use" and exited although nothing listened, and only a second
start a little later came up. The real server (uvicorn) binds WITH SO_REUSEADDR, which
ignores TIME_WAIT but still fails on a live listener. The check now binds the same way,
so it fails only when another process really listens on the port.

Standard library only.
"""
import socket


def _family(host):
    return socket.AF_INET6 if host and ":" in host else socket.AF_INET


def port_is_free(host, port):
    """Return (True, None) if (host, port) can be listened on, else (False, OSError)."""
    try:
        with socket.socket(_family(host), socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, port))
            s.listen(1)
    except OSError as e:
        return False, e
    return True, None
