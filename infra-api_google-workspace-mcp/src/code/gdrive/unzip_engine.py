"""
Unzip a Drive zip straight into Drive, as a background job (#1659).

Why a job. A Takeout zip is thousands of files and tens of minutes to hours of
uploads. No MCP call may hold a connection that long, so `start` returns a job id
at once and `status` reports progress, counts, failures and the final summary.

Memory. The zip is streamed to a file on disk (core.streaming.download_to_file,
bounded chunks). Members are extracted one at a time, each to its own temp file,
in 1 MiB reads, and uploaded from that file (resumable above 4 MiB, so one upload
chunk in memory per worker). Nothing holds a whole member or the zip in memory.

Concurrency. Uploads run on a few worker threads, each with its OWN Drive client
(httplib2 connections are not thread-safe). Folder creation is serialised under
one lock and resolved before any upload starts, so two workers cannot create the
same folder twice.

This module is standard library only at import time (the Google client is
reached through the injected service factory), so it is unit-tested against a
fake Drive backend with no Google packages installed. The logic is the one
proven live on 2026-11-11 with the Takeout and repository-backup runs.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import shutil
import threading
import time
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, List, Optional, Tuple

from core import streaming

logger = logging.getLogger(__name__)

FOLDER_MIME = "application/vnd.google-apps.folder"
SHORTCUT_MIME = "application/vnd.google-apps.shortcut"
EXTRACT_READ_BYTES = 1024 * 1024
MAX_WORKERS = 8
DEFAULT_WORKERS = 4
MAX_FAILURES_KEPT = 50
UPLOAD_ATTEMPTS = 4
API_RETRIES = 6
JOB_ID_RE = re.compile(r"^[0-9a-f]{12}$")
# One unzip at a time by default: each job already uses several upload threads.
MAX_ACTIVE_JOBS = max(1, int(os.getenv("WORKSPACE_MCP_UNZIP_MAX_JOBS", "1") or 1))
FINISHED_STATES = ("done", "done_with_failures", "failed", "cancelled")


class UnzipError(Exception):
    """A problem the caller can act on (bad input, no room, not a zip)."""


def safe_parts(member_name: str) -> Optional[List[str]]:
    """
    Path components of a zip member, or None when the name is unusable.
    Drops empty and '.' components; a '..' component rejects the member (a zip
    must not place files outside the destination folder).
    """
    parts = [p for p in member_name.replace("\\", "/").split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    return parts


def common_wrapper(paths: List[List[str]]) -> Optional[str]:
    """The single top-level directory every member sits under, if there is one."""
    if not paths:
        return None
    first = paths[0][0]
    for parts in paths:
        if len(parts) < 2 or parts[0] != first:
            return None
    return first


def _http_status(exc: BaseException) -> Optional[int]:
    resp = getattr(exc, "resp", None)
    status = getattr(resp, "status", None)
    try:
        return int(status) if status is not None else None
    except (TypeError, ValueError):
        return None


def _process_start_time(pid: str = "self", proc: str = "/proc") -> str:
    """Field 22 of /proc/<pid>/stat: what tells this process from a later one with the same pid."""
    try:
        with open(f"{proc}/{pid}/stat") as fh:
            return fh.read().rsplit(") ", 1)[1].split()[19]
    except (OSError, IndexError):
        return "0"


def deploy_hold_until() -> float:
    """Epoch until which a waiting redeploy has closed admission (0 = open)."""
    try:
        with open(streaming.tmp_dir() / ".deploy-hold") as fh:
            return float(fh.read().strip() or 0)
    except (OSError, ValueError):
        return 0.0


def _default_media_factory(path: str, mimetype: str, resumable: bool, chunksize: int):
    from googleapiclient.http import MediaFileUpload

    return MediaFileUpload(path, mimetype=mimetype, resumable=resumable, chunksize=chunksize)


class UnzipJob:
    """One unzip-to-Drive run. `run()` blocks; `status()` is safe from any thread."""

    def __init__(
        self,
        *,
        zip_file_id: str,
        service_factory: Callable[[], Any],
        destination_folder_id: Optional[str] = None,
        strip_wrapper_dir: bool = False,
        skip_existing: bool = True,
        workers: int = DEFAULT_WORKERS,
        job_id: Optional[str] = None,
        work_dir: Optional[str] = None,
        media_factory: Optional[Callable[..., Any]] = None,
        downloader_cls: Optional[Callable[..., Any]] = None,
        sleep: Callable[[float], None] = time.sleep,
        owner: Optional[str] = None,
    ):
        self.job_id = job_id or uuid.uuid4().hex[:12]
        self.zip_file_id = zip_file_id
        self.destination_folder_id = destination_folder_id or None
        self.strip_wrapper_dir = bool(strip_wrapper_dir)
        self.skip_existing = bool(skip_existing)
        self.workers = max(1, min(int(workers or DEFAULT_WORKERS), MAX_WORKERS))
        self.owner = owner
        self._service_factory = service_factory
        self._media_factory = media_factory or _default_media_factory
        self._downloader_cls = downloader_cls
        self._sleep = sleep
        self._work_dir = work_dir or str(streaming.tmp_dir() / f"unzip-{self.job_id}")
        self._tl = threading.local()
        self._lock = threading.Lock()  # counters and status
        self._folder_lock = threading.Lock()  # listings and folder creation
        self._cancel = threading.Event()
        self._kids: Dict[str, Dict[str, Any]] = {}
        self._last_persist = 0.0
        self._closables: List[Any] = []  # per-thread Drive clients and zip handles
        self._s: Dict[str, Any] = {
            "job_id": self.job_id,
            "state": "queued",
            "phase": "queued",
            "zip": {"id": zip_file_id},
            "destination": {"id": self.destination_folder_id},
            "options": {
                "strip_wrapper_dir": self.strip_wrapper_dir,
                "skip_existing": self.skip_existing,
                "workers": self.workers,
            },
            "download_bytes": 0,
            "total_files": None,
            "uploaded": 0,
            "skipped": 0,
            "failed": 0,
            "bytes_uploaded": 0,
            "folders_created": 0,
            "wrapper_stripped": None,
            "failures": [],
            "failures_truncated": 0,
            "started_at": None,
            "finished_at": None,
            "error": None,
            "summary": None,
        }

    # ── public ──────────────────────────────────────────────────────────────

    def status(self) -> Dict[str, Any]:
        with self._lock:
            out = json.loads(json.dumps(self._s))
        start, end = out.get("started_at"), out.get("finished_at")
        if start:
            out["elapsed_seconds"] = int((end or time.time()) - start)
        total = out.get("total_files")
        if total:
            done = out["uploaded"] + out["skipped"] + out["failed"]
            out["progress_pct"] = round(100.0 * done / total, 1)
        return out

    def cancel(self) -> None:
        self._cancel.set()

    @property
    def finished(self) -> bool:
        with self._lock:
            return self._s["state"] in FINISHED_STATES

    def register_active(self) -> None:
        """
        Mark this job live for the deploy drain probe (src/drain-probe.sh): a file
        naming the server process, removed when the job ends. A redeploy waits
        for it instead of killing the job mid-upload.
        """
        os.makedirs(self._work_dir, exist_ok=True)
        streaming.protect_tmp(self._work_dir)
        try:
            # Atomic: write a temp file, then rename. A reader (the drain probe, or the test right after
            # start_job) must never see ACTIVE existing but still empty.
            active = os.path.join(self._work_dir, "ACTIVE")
            with open(active + ".tmp", "w") as fh:
                fh.write(f"{os.getpid()} {_process_start_time()}\n")
            os.replace(active + ".tmp", active)
        except OSError:
            pass

    def run(self) -> Dict[str, Any]:
        self._set(state="running", phase="starting", started_at=time.time())
        self.register_active()
        try:
            self._run()
        except _Cancelled:
            self._finish("cancelled")
        except UnzipError as e:
            self._finish("failed", error=str(e))
        except Exception as e:  # noqa: BLE001 - a job thread must record, never raise
            logger.exception(f"[unzip {self.job_id}] crashed")
            self._finish("failed", error=f"{type(e).__name__}: {e}"[:500])
        finally:
            self._cleanup()
        return self.status()

    # ── steps ───────────────────────────────────────────────────────────────

    def _run(self) -> None:
        svc = self._svc()
        meta = self._resolve_zip(svc)
        dest_id = self._resolve_destination(svc, meta)

        size = int(meta["size"])
        try:
            # the zip itself, plus room for one extracted member per worker
            streaming.ensure_room(size, f"The zip '{meta.get('name')}'")
        except streaming.TooLargeError as e:
            raise UnzipError(str(e)) from None

        zip_path = os.path.join(self._work_dir, "source.zip")
        self._set(phase="downloading")
        streaming.download_to_file(
            svc.files().get_media(fileId=meta["id"], supportsAllDrives=True),
            zip_path,
            num_retries=API_RETRIES,
            on_progress=lambda n: self._set(download_bytes=n),
            downloader_cls=self._downloader_cls,
        )
        self._check_cancel()

        if not zipfile.is_zipfile(zip_path):
            raise UnzipError(f"'{meta.get('name')}' is not a zip archive.")
        self._set(phase="reading")
        plan, bad = self._plan(zip_path)
        self._set(total_files=len(plan) + len(bad))
        for name, why in bad:
            self._fail(name, why)

        self._set(phase="creating_folders")
        targets = self._resolve_folders(dest_id, plan)
        self._check_cancel()

        self._set(phase="uploading")
        with ThreadPoolExecutor(self.workers, thread_name_prefix=f"unzip-{self.job_id}") as pool:
            list(pool.map(lambda item: self._one(zip_path, item, targets), plan))

        if self._cancel.is_set():
            self._finish("cancelled")
        else:
            with self._lock:
                failed = self._s["failed"]
            self._finish("done_with_failures" if failed else "done")

    def _resolve_zip(self, svc: Any) -> Dict[str, Any]:
        file_id = self.zip_file_id
        for _hop in range(5):
            meta = self._ex(
                svc.files().get(
                    fileId=file_id,
                    fields="id, name, mimeType, size, parents, shortcutDetails",
                    supportsAllDrives=True,
                )
            )
            if meta.get("mimeType") != SHORTCUT_MIME:
                break
            file_id = (meta.get("shortcutDetails") or {}).get("targetId")
            if not file_id:
                raise UnzipError("The shortcut has no target.")
        else:
            raise UnzipError("Too many shortcut hops.")
        if meta.get("mimeType") == FOLDER_MIME:
            raise UnzipError(f"'{meta.get('name')}' is a folder, not a zip file.")
        if meta.get("size") is None:
            raise UnzipError(
                f"'{meta.get('name')}' ({meta.get('mimeType')}) has no binary content to unzip."
            )
        self._set(zip={"id": meta["id"], "name": meta.get("name"), "size": int(meta["size"])})
        return meta

    def _resolve_destination(self, svc: Any, meta: Dict[str, Any]) -> str:
        dest_id = self.destination_folder_id
        if not dest_id:
            parents = meta.get("parents") or []
            if not parents:
                raise UnzipError(
                    "The zip has no parent folder visible to this account; "
                    "pass destination_folder_id."
                )
            dest_id = parents[0]
        dest = self._ex(
            svc.files().get(fileId=dest_id, fields="id, name, mimeType", supportsAllDrives=True)
        )
        if dest.get("mimeType") != FOLDER_MIME:
            raise UnzipError(f"Destination '{dest.get('name')}' ({dest_id}) is not a folder.")
        self._set(destination={"id": dest["id"], "name": dest.get("name")})
        return dest["id"]

    def _plan(self, zip_path: str) -> Tuple[List[Tuple[str, List[str], int]], List[Tuple[str, str]]]:
        """([(member, path parts, size)], [(member, reason it cannot be extracted)])."""
        plan: List[Tuple[str, List[str], int]] = []
        bad: List[Tuple[str, str]] = []
        with zipfile.ZipFile(zip_path) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                parts = safe_parts(info.filename)
                if parts is None:
                    bad.append((info.filename, "unsafe or empty path in the archive"))
                elif info.flag_bits & 0x1:
                    bad.append((info.filename, "encrypted member (no password support)"))
                else:
                    plan.append((info.filename, parts, info.file_size))
        wrapper = common_wrapper([p for _m, p, _s in plan]) if self.strip_wrapper_dir else None
        if wrapper is not None:
            plan = [(m, p[1:], s) for m, p, s in plan]
        self._set(wrapper_stripped=wrapper if self.strip_wrapper_dir else None)
        return plan, bad

    def _resolve_folders(self, dest_id: str, plan: List[Tuple[str, List[str], int]]) -> Dict[str, str]:
        """Create or find every directory first, serially, so uploads only create files."""
        targets: Dict[str, str] = {"": dest_id}
        for _member, parts, _size in plan:
            parent = dest_id
            for i, name in enumerate(parts[:-1]):
                key = "/".join(parts[: i + 1])
                if key not in targets:
                    self._check_cancel()
                    targets[key] = self._folder(parent, name)
                parent = targets[key]
        return targets

    def _one(self, zip_path: str, item: Tuple[str, List[str], int], targets: Dict[str, str]) -> None:
        member, parts, size = item
        if self._cancel.is_set():
            return
        shown = "/".join(parts)
        name = parts[-1]
        parent = targets["/".join(parts[:-1])]
        tmp = os.path.join(self._work_dir, f"member-{threading.get_ident()}.bin")
        try:
            existing = self._listing(parent).get(name)
            if self.skip_existing and existing and size in existing["sizes"]:
                self._count("skipped")
                return
            if size > 0:
                free = shutil.disk_usage(self._work_dir).free
                if size + streaming.DISK_RESERVE_BYTES > free:
                    raise UnzipError(f"not enough disk to extract {size} bytes ({free} free)")
                self._extract(zip_path, member, tmp)
            self._upload_with_retries(parent, name, tmp if size > 0 else None, size)
            with self._folder_lock:
                entry = self._kids[parent].setdefault(name, {"folder": None, "sizes": set()})
                entry["sizes"].add(size)
            self._count("uploaded", size)
        except Exception as e:  # noqa: BLE001 - one bad member must not stop the job
            self._fail(shown, f"{type(e).__name__}: {e}"[:300])
        finally:
            streaming.remove_quietly(tmp)

    def _extract(self, zip_path: str, member: str, dest: str) -> None:
        with self._zip(zip_path).open(member) as src, open(dest, "wb") as dst:
            while True:
                block = src.read(EXTRACT_READ_BYTES)
                if not block:
                    break
                dst.write(block)

    def _upload_with_retries(self, parent: str, name: str, path: Optional[str], size: int) -> None:
        delay = 2.0
        for attempt in range(1, UPLOAD_ATTEMPTS + 1):
            try:
                self._upload(parent, name, path, size)
                return
            except Exception as e:  # noqa: BLE001
                status = _http_status(e)
                permanent = status is not None and 400 <= status < 500 and status not in (403, 408, 429)
                if permanent or attempt == UPLOAD_ATTEMPTS or self._cancel.is_set():
                    raise
                logger.warning(
                    f"[unzip {self.job_id}] upload of {name} failed "
                    f"(attempt {attempt}/{UPLOAD_ATTEMPTS}): {e}; retrying in {delay:.0f}s"
                )
                self._sleep(delay)
                delay *= 2

    def _upload(self, parent: str, name: str, path: Optional[str], size: int) -> None:
        svc = self._svc()
        body = {"name": name, "parents": [parent]}
        if path is None:  # empty file: metadata only
            self._ex(svc.files().create(body=body, fields="id", supportsAllDrives=True))
            return
        mimetype = mimetypes.guess_type(name)[0] or "application/octet-stream"
        resumable = size > streaming.RESUMABLE_THRESHOLD_BYTES
        media = self._media_factory(path, mimetype, resumable, streaming.UPLOAD_CHUNK_BYTES)
        request = svc.files().create(
            body=body, media_body=media, fields="id", supportsAllDrives=True
        )
        try:
            if resumable:
                response = None
                while response is None:
                    _progress, response = request.next_chunk(num_retries=API_RETRIES)
            else:
                self._ex(request)
        finally:
            stream = getattr(media, "_fd", None)  # MediaFileUpload keeps the file open
            if stream is not None:
                try:
                    stream.close()
                except Exception:  # noqa: BLE001
                    pass

    # ── Drive helpers ───────────────────────────────────────────────────────

    def _svc(self) -> Any:
        """One Drive client per thread."""
        svc = getattr(self._tl, "svc", None)
        if svc is None:
            svc = self._tl.svc = self._service_factory()
            with self._lock:
                self._closables.append(svc)
        return svc

    def _zip(self, zip_path: str) -> zipfile.ZipFile:
        """One ZipFile handle per thread (a handle is not safe to share)."""
        zf = getattr(self._tl, "zf", None)
        if zf is None:
            zf = self._tl.zf = zipfile.ZipFile(zip_path)
            with self._lock:
                self._closables.append(zf)
        return zf

    @staticmethod
    def _ex(request: Any) -> Any:
        return request.execute(num_retries=API_RETRIES)

    def _listing(self, parent: str) -> Dict[str, Any]:
        """name -> {'folder': id or None, 'sizes': set of file sizes}, cached per folder."""
        with self._folder_lock:
            if parent not in self._kids:
                self._kids[parent] = self._children(parent)
            return self._kids[parent]

    def _children(self, parent: str) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        token = None
        svc = self._svc()
        while True:
            resp = self._ex(
                svc.files().list(
                    q=f"'{parent}' in parents and trashed=false",
                    fields="nextPageToken, files(id, name, mimeType, size)",
                    pageSize=1000,
                    pageToken=token,
                    supportsAllDrives=True,
                    includeItemsFromAllDrives=True,
                )
            )
            for f in resp.get("files", []):
                entry = out.setdefault(f["name"], {"folder": None, "sizes": set()})
                if f.get("mimeType") == FOLDER_MIME:
                    entry["folder"] = entry["folder"] or f["id"]
                elif f.get("size") is not None:
                    entry["sizes"].add(int(f["size"]))
            token = resp.get("nextPageToken")
            if not token:
                return out

    def _folder(self, parent: str, name: str) -> str:
        """Find or create a folder. The whole check-then-create is under one lock."""
        with self._folder_lock:
            if parent not in self._kids:
                self._kids[parent] = self._children(parent)
            entry = self._kids[parent].setdefault(name, {"folder": None, "sizes": set()})
            if entry["folder"]:
                return entry["folder"]
            created = self._ex(
                self._svc().files().create(
                    body={"name": name, "mimeType": FOLDER_MIME, "parents": [parent]},
                    fields="id",
                    supportsAllDrives=True,
                )
            )
            entry["folder"] = created["id"]
            self._kids[created["id"]] = {}  # a folder we just made is empty
        self._count("folders_created")
        return created["id"]

    # ── bookkeeping ─────────────────────────────────────────────────────────

    def _set(self, **fields: Any) -> None:
        with self._lock:
            self._s.update(fields)
        self._persist()

    def _count(self, key: str, nbytes: int = 0) -> None:
        with self._lock:
            self._s[key] += 1
            if key == "uploaded":
                self._s["bytes_uploaded"] += nbytes
        self._persist()

    def _fail(self, name: str, why: str) -> None:
        logger.warning(f"[unzip {self.job_id}] FAIL {name}: {why}")
        with self._lock:
            self._s["failed"] += 1
            if len(self._s["failures"]) < MAX_FAILURES_KEPT:
                self._s["failures"].append({"path": name, "error": why})
            else:
                self._s["failures_truncated"] += 1
        self._persist()

    def _check_cancel(self) -> None:
        if self._cancel.is_set():
            raise _Cancelled()

    def _finish(self, state: str, error: Optional[str] = None) -> None:
        with self._lock:
            s = self._s
            s["state"] = state
            s["phase"] = "finished"
            s["finished_at"] = time.time()
            s["error"] = error
            took = int(s["finished_at"] - (s["started_at"] or s["finished_at"]))
            s["summary"] = (
                f"{state}: {s['uploaded']} uploaded ({s['bytes_uploaded']} bytes), "
                f"{s['skipped']} skipped (already present, same size), {s['failed']} failed, "
                f"{s['folders_created']} folders created, of {s['total_files'] or 0} files "
                f"in '{(s['zip'] or {}).get('name')}' -> '{(s['destination'] or {}).get('name')}' "
                f"in {took}s" + (f". Error: {error}" if error else "")
            )
        logger.info(f"[unzip {self.job_id}] {self._s['summary']}")
        self._persist(force=True)

    def _persist(self, force: bool = False) -> None:
        """Status on disk, so a status call after a restart can say what happened."""
        now = time.time()
        if not force and now - self._last_persist < 5:
            return
        self._last_persist = now
        try:
            path = os.path.join(self._work_dir, "status.json")
            with open(path + ".tmp", "w") as fh:
                json.dump(self.status(), fh)
            os.replace(path + ".tmp", path)
        except OSError:
            pass

    def _cleanup(self) -> None:
        """Remove the zip and member temp files; keep status.json for the age sweep."""
        with self._lock:
            closables, self._closables = self._closables, []
        for obj in closables:
            try:
                obj.close()
            except Exception:  # noqa: BLE001
                pass
        try:
            for name in os.listdir(self._work_dir):
                if name != "status.json":
                    streaming.remove_quietly(os.path.join(self._work_dir, name))
        except OSError:
            pass
        streaming.unprotect_tmp(self._work_dir)


class _Cancelled(UnzipError):
    def __init__(self) -> None:
        super().__init__("cancelled by request")


# ── job registry ────────────────────────────────────────────────────────────

_jobs: Dict[str, UnzipJob] = {}
_jobs_lock = threading.Lock()


def start_job(**kwargs: Any) -> UnzipJob:
    """Create a job and run it on its own daemon thread. Returns at once."""
    with _jobs_lock:
        active = [j for j in _jobs.values() if not j.finished]
        if len(active) >= MAX_ACTIVE_JOBS:
            raise UnzipError(
                f"{len(active)} unzip job(s) already running (limit {MAX_ACTIVE_JOBS}): "
                f"{', '.join(j.job_id for j in active)}. Wait for it, or cancel it."
            )
        held = "A redeploy of this server is waiting for running jobs to finish and has closed admission; start the unzip again after the restart (a few minutes)."
        if deploy_hold_until() > time.time():
            raise UnzipError(held)
        job = UnzipJob(**kwargs)
        # Register first, check the hold second: a job racing a drain is either seen
        # by the probe or refused here, never neither.
        job.register_active()
        if deploy_hold_until() > time.time():
            job._cleanup()
            raise UnzipError(held)
        _jobs[job.job_id] = job
        # keep the registry small: drop the oldest finished jobs beyond 20
        finished = [j for j in _jobs.values() if j.finished]
        for old in finished[:-20]:
            _jobs.pop(old.job_id, None)
    threading.Thread(target=job.run, name=f"unzip-job-{job.job_id}", daemon=True).start()
    return job


def get_job(job_id: str) -> Optional[UnzipJob]:
    with _jobs_lock:
        return _jobs.get(job_id)


def job_status(job_id: str) -> Optional[Dict[str, Any]]:
    """Live status, or the last status written to disk by a previous process."""
    job = get_job(job_id)
    if job is not None:
        return job.status()
    if not JOB_ID_RE.match(job_id or ""):
        return None
    path = streaming.tmp_dir() / f"unzip-{job_id}" / "status.json"
    try:
        with open(path) as fh:
            status = json.load(fh)
    except (OSError, ValueError):
        return None
    if status.get("state") not in FINISHED_STATES:
        status["state"] = "interrupted"
        status["error"] = (
            "The server restarted while this job was running. Start it again with "
            "skip_existing=true: files already uploaded are skipped."
        )
    return status


def list_jobs() -> List[Dict[str, Any]]:
    with _jobs_lock:
        jobs = list(_jobs.values())
    return [j.status() for j in jobs]


def jobs_summary() -> Dict[str, int]:
    with _jobs_lock:
        jobs = list(_jobs.values())
    active = sum(1 for j in jobs if not j.finished)
    return {"active": active, "finished": len(jobs) - active, "limit": MAX_ACTIVE_JOBS}
