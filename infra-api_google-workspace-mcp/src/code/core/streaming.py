"""
Bounded-memory plumbing for heavy Drive calls (#1659).

THE DEFECT. `get_drive_file_download_url` on a 417 MB zip pulled the whole file
into a BytesIO, copied it with getvalue(), base64-encoded it and decoded it again
before writing: about four copies in a container capped at 2 GiB. The kernel
killed it (exit 137) and, with restart policy "no", it stayed down.

THE RULE. A Drive download goes to a file on disk in chunks of at most
MAX_CHUNK_BYTES; nothing in this server holds a whole Drive file in memory.
Heavy calls take a slot from a small semaphore, so N parallel requests cannot
multiply the per-request budget. Temp files live in one directory with a quota
and are swept by age.

Standard library only at import time, so the unit tests run without the Google
client installed; googleapiclient is imported inside the functions that use it.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

MIB = 1024 * 1024
GIB = 1024 * MIB

# Hard ceiling for any single buffer a Drive transfer may hold.
MAX_CHUNK_BYTES = 16 * MIB


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        value = int(os.getenv(name, "") or default)
    except ValueError:
        value = default
    return max(lo, min(hi, value))


DOWNLOAD_CHUNK_BYTES = _env_int(
    "WORKSPACE_MCP_DOWNLOAD_CHUNK_BYTES", 8 * MIB, 256 * 1024, MAX_CHUNK_BYTES
)
UPLOAD_CHUNK_BYTES = _env_int(
    "WORKSPACE_MCP_UPLOAD_CHUNK_BYTES", 8 * MIB, 256 * 1024, MAX_CHUNK_BYTES
)
# Uploads above this size use the resumable protocol (one chunk in memory at a time).
RESUMABLE_THRESHOLD_BYTES = 4 * MIB
# A text read (get_drive_file_content) returns the file inside the MCP response,
# so it is loaded; above this it is refused with a clear message instead.
MAX_TEXT_BYTES = _env_int("WORKSPACE_MCP_MAX_TEXT_BYTES", 20 * MIB, 64 * 1024, 256 * MIB)
HEAVY_CONCURRENCY = _env_int("WORKSPACE_MCP_HEAVY_CONCURRENCY", 2, 1, 16)
HEAVY_WAIT_SECONDS = _env_int("WORKSPACE_MCP_HEAVY_WAIT_SECONDS", 120, 1, 3600)
TMP_QUOTA_BYTES = _env_int("WORKSPACE_MCP_TMP_QUOTA_BYTES", 20 * GIB, 64 * MIB, 4096 * GIB)
TMP_MAX_AGE_SECONDS = _env_int("WORKSPACE_MCP_TMP_MAX_AGE_SECONDS", 6 * 3600, 60, 30 * 86400)
# Space the temp dir never eats into: the host disk is shared with every other container.
DISK_RESERVE_BYTES = _env_int("WORKSPACE_MCP_DISK_RESERVE_BYTES", 1 * GIB, 0, 4096 * GIB)


class TooLargeError(Exception):
    """A transfer exceeded its byte limit, or the disk cannot hold it."""


class BusyError(Exception):
    """No heavy-call slot became free in time."""


# ── temp directory ──────────────────────────────────────────────────────────


def tmp_dir() -> Path:
    """The one on-disk scratch directory for heavy calls (created on first use)."""
    path = Path(
        os.getenv("WORKSPACE_MCP_TMP_DIR")
        or os.path.join(os.getenv("TMPDIR") or "/tmp", "workspace-mcp")
    )
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def new_tmp_path(prefix: str = "dl", suffix: str = "") -> Path:
    return tmp_dir() / f"{prefix}-{uuid.uuid4().hex}{suffix}"


def dir_usage_bytes(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


def ensure_room(need_bytes: int, what: str = "file") -> None:
    """Raise TooLargeError when the temp dir cannot take `need_bytes` more."""
    path = tmp_dir()
    used = dir_usage_bytes(path)
    if used + need_bytes > TMP_QUOTA_BYTES:
        raise TooLargeError(
            f"{what} needs {need_bytes} bytes of temp space but the temp directory "
            f"already holds {used} of its {TMP_QUOTA_BYTES} byte quota "
            f"(WORKSPACE_MCP_TMP_QUOTA_BYTES)."
        )
    free = shutil.disk_usage(path).free
    if need_bytes + DISK_RESERVE_BYTES > free:
        raise TooLargeError(
            f"{what} needs {need_bytes} bytes of temp space but only {free} bytes are free "
            f"on the disk ({DISK_RESERVE_BYTES} are kept in reserve)."
        )


def remove_quietly(path: Any) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


_protected: set = set()


def protect_tmp(path: Any) -> None:
    """Exempt a temp entry from the age sweep while a long job owns it."""
    _protected.add(str(path))


def unprotect_tmp(path: Any) -> None:
    _protected.discard(str(path))


def sweep_tmp(max_age_seconds: Optional[int] = None, now: Optional[float] = None) -> int:
    """Delete temp entries older than max_age_seconds. Returns how many were removed."""
    limit = TMP_MAX_AGE_SECONDS if max_age_seconds is None else max_age_seconds
    now = time.time() if now is None else now
    removed = 0
    try:
        entries = list(tmp_dir().iterdir())
    except OSError:
        return 0
    for entry in entries:
        try:
            if str(entry) in _protected:
                continue
            if now - entry.lstat().st_mtime <= limit:
                continue
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry, ignore_errors=True)
            else:
                entry.unlink()
            removed += 1
        except OSError:
            pass
    return removed


# ── chunked download ────────────────────────────────────────────────────────


def download_to_file(
    request: Any,
    dest: Any,
    *,
    chunk_bytes: int = DOWNLOAD_CHUNK_BYTES,
    max_bytes: Optional[int] = None,
    num_retries: int = 5,
    on_progress: Optional[Callable[[int], None]] = None,
    downloader_cls: Optional[Callable[..., Any]] = None,
) -> int:
    """
    Stream a Drive media request (files().get_media / export_media) into the file
    `dest`, one chunk at a time. Returns the number of bytes written.

    The file handle is the only sink: at no point is more than one chunk
    (<= MAX_CHUNK_BYTES) of the file in memory. If max_bytes is given and the
    download grows past it, the partial file is deleted and TooLargeError raised.
    Blocking: call it from a worker thread.
    """
    chunk = max(1, min(int(chunk_bytes), MAX_CHUNK_BYTES))
    if downloader_cls is None:
        from googleapiclient.http import MediaIoBaseDownload

        downloader_cls = MediaIoBaseDownload
    try:
        with open(dest, "wb") as fh:
            downloader = downloader_cls(fh, request, chunksize=chunk)
            done = False
            while not done:
                _status, done = downloader.next_chunk(num_retries=num_retries)
                written = fh.tell()
                if max_bytes is not None and written > max_bytes:
                    raise TooLargeError(
                        f"download exceeded the {max_bytes} byte limit after {written} bytes"
                    )
                if on_progress is not None:
                    on_progress(written)
            return fh.tell()
    except BaseException:
        remove_quietly(dest)
        raise


def read_head(path: Any, n: int) -> bytes:
    with open(path, "rb") as fh:
        return fh.read(n)


# ── heavy-call concurrency ──────────────────────────────────────────────────

_heavy_lock = threading.Lock()
_heavy_semaphores: Dict[int, asyncio.Semaphore] = {}
_heavy_active = 0
_heavy_waiting = 0


def _semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    with _heavy_lock:
        sem = _heavy_semaphores.get(id(loop))
        if sem is None:
            sem = asyncio.Semaphore(HEAVY_CONCURRENCY)
            _heavy_semaphores.clear()  # one live loop per server process
            _heavy_semaphores[id(loop)] = sem
        return sem


@asynccontextmanager
async def heavy_slot(name: str, wait_seconds: Optional[float] = None):
    """
    Hold one of HEAVY_CONCURRENCY slots for a call that moves file content.
    Waits up to wait_seconds for a slot, then raises BusyError (a clear answer
    beats an MCP call that hangs until the client gives up).
    """
    global _heavy_active, _heavy_waiting
    sem = _semaphore()
    timeout = HEAVY_WAIT_SECONDS if wait_seconds is None else wait_seconds
    with _heavy_lock:
        _heavy_waiting += 1
    try:
        try:
            await asyncio.wait_for(sem.acquire(), timeout=timeout)
        except asyncio.TimeoutError:
            raise BusyError(
                f"{name}: the server is busy with {HEAVY_CONCURRENCY} other large "
                f"file operations; no slot became free within {int(timeout)}s. Retry shortly."
            ) from None
    finally:
        with _heavy_lock:
            _heavy_waiting -= 1
    with _heavy_lock:
        _heavy_active += 1
    try:
        yield
    finally:
        with _heavy_lock:
            _heavy_active -= 1
        sem.release()


def heavy_stats() -> Dict[str, int]:
    with _heavy_lock:
        return {
            "limit": HEAVY_CONCURRENCY,
            "active": _heavy_active,
            "waiting": _heavy_waiting,
        }


# ── memory headroom ─────────────────────────────────────────────────────────


def _read_int(path: str) -> Optional[int]:
    try:
        with open(path) as fh:
            raw = fh.read().strip()
    except OSError:
        return None
    if raw == "max":
        return None
    try:
        return int(raw)
    except ValueError:
        return None


def _meminfo(root: str) -> Dict[str, int]:
    out: Dict[str, int] = {}
    try:
        with open(os.path.join(root, "proc/meminfo")) as fh:
            for line in fh:
                key, _, rest = line.partition(":")
                parts = rest.split()
                if parts and parts[0].isdigit():
                    out[key] = int(parts[0]) * 1024
    except OSError:
        pass
    return out


def memory_headroom(root: str = "/") -> Dict[str, Any]:
    """
    How far this container is from its memory ceiling.

    cgroup v2 (memory.max / memory.current), then cgroup v1, then the host's
    MemAvailable when no ceiling is set. `headroom_bytes` is what can still be
    allocated before the cgroup OOM killer acts; inactive page cache is counted
    as reclaimable.
    """
    cg = os.path.join(root, "sys/fs/cgroup")
    limit = _read_int(os.path.join(cg, "memory.max"))
    current = _read_int(os.path.join(cg, "memory.current"))
    source = "cgroup-v2"
    reclaimable = 0
    if current is None:
        limit = _read_int(os.path.join(cg, "memory/memory.limit_in_bytes"))
        current = _read_int(os.path.join(cg, "memory/memory.usage_in_bytes"))
        source = "cgroup-v1"
        if limit is not None and limit >= 1 << 60:  # v1 spelling of "no limit"
            limit = None
    else:
        try:
            with open(os.path.join(cg, "memory.stat")) as fh:
                for line in fh:
                    if line.startswith("inactive_file "):
                        reclaimable = int(line.split()[1])
                        break
        except (OSError, ValueError, IndexError):
            reclaimable = 0
    info = _meminfo(root)
    if current is None:
        source = "meminfo"
    if limit is None:
        total = info.get("MemTotal")
        available = info.get("MemAvailable")
        headroom = available
        limit_out = total
        limited = False
    else:
        used = max(0, (current or 0) - reclaimable)
        headroom = max(0, limit - used)
        limit_out = limit
        limited = True
    pct = None
    if headroom is not None and limit_out:
        pct = round(100.0 * headroom / limit_out, 1)
    return {
        "source": source,
        "limited": limited,
        "limit_bytes": limit_out,
        "current_bytes": current,
        "reclaimable_bytes": reclaimable,
        "headroom_bytes": headroom,
        "headroom_pct": pct,
        "low": bool(pct is not None and pct < 15.0),
    }


def health_snapshot() -> Dict[str, Any]:
    """Cheap figures for /health: memory headroom, heavy slots, temp dir."""
    path = tmp_dir()
    try:
        free = shutil.disk_usage(path).free
    except OSError:
        free = None
    return {
        "memory": memory_headroom(),
        "heavy_calls": heavy_stats(),
        "tmp": {
            "dir": str(path),
            "used_bytes": dir_usage_bytes(path),
            "quota_bytes": TMP_QUOTA_BYTES,
            "disk_free_bytes": free,
        },
        "limits": {
            "download_chunk_bytes": DOWNLOAD_CHUNK_BYTES,
            "upload_chunk_bytes": UPLOAD_CHUNK_BYTES,
            "max_text_bytes": MAX_TEXT_BYTES,
        },
    }
