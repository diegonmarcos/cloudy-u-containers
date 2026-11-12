"""#1659: the unzip-to-Drive job against a fake Drive backend (no Google packages)."""
import io
import os
import threading
import time
import unittest
import zipfile

try:
    from . import _env  # noqa: F401
except ImportError:
    import _env  # noqa: F401

from core import streaming
from gdrive import unzip_engine as ue

MIB = 1024 * 1024
FOLDER = ue.FOLDER_MIME


class HttpError(Exception):
    def __init__(self, status):
        super().__init__(f"HTTP {status}")
        self.resp = type("R", (), {"status": status})()


class FakeDrive:
    """In-memory Drive: files().get / list / create / get_media with the googleapiclient call shape."""

    def __init__(self):
        self.lock = threading.Lock()
        self.items = {}
        self.n = 0
        self.clients = []
        self.fail = {}            # file name -> list of exceptions to raise on create, in order
        self.resumable_names = []
        self.simple_names = []
        self.max_chunksize = 0
        self.hold_download = None  # threading.Event the download waits on
        self.add("root", "My Drive", FOLDER, parent=None)

    def add(self, fid, name, mime, parent, content=None):
        self.items[fid] = {"id": fid, "name": name, "mimeType": mime, "parents": [parent] if parent else [],
                           "content": content, "size": None if content is None else len(content)}
        return fid

    def add_zip(self, entries, name="a.zip", parent="root", fid="zip1"):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for path, data in entries:
                zf.writestr(path, data)
        return self.add(fid, name, "application/zip", parent, buf.getvalue())

    def client(self):
        c = FakeService(self)
        with self.lock:
            self.clients.append(c)
        return c

    def children(self, parent):
        return [i for i in self.items.values() if parent in i["parents"]]

    def tree(self, parent="root", prefix=""):
        out = {}
        for i in self.children(parent):
            if i["mimeType"] == FOLDER:
                out.update(self.tree(i["id"], f"{prefix}{i['name']}/"))
            elif i["id"] != "zip1":
                out[f"{prefix}{i['name']}"] = i["size"]
        return out

    def folders(self):
        return [(i["parents"][0], i["name"]) for i in self.items.values() if i["mimeType"] == FOLDER and i["parents"]]


class FakeService:
    def __init__(self, drive):
        self.drive, self.threads, self.closed = drive, set(), False

    def files(self):
        self.threads.add(threading.get_ident())
        return FakeFiles(self.drive)

    def close(self):
        self.closed = True


class Req:
    resumable = None

    def __init__(self, fn):
        self.fn = fn

    def execute(self, num_retries=0):
        return self.fn()


class CreateReq(Req):
    def __init__(self, drive, body, media):
        self.drive, self.body, self.media, self.chunks = drive, body, media, 0
        self.resumable = media if (media is not None and media.resumable) else None

    def _do(self):
        d, name = self.drive, self.body["name"]
        with d.lock:
            queue = d.fail.get(name)
            if queue:
                raise queue.pop(0)
            d.n += 1
            fid = f"f{d.n}"
            if self.body.get("mimeType") == FOLDER:
                d.add(fid, name, FOLDER, self.body["parents"][0])
            else:
                size = os.path.getsize(self.media.path) if self.media else 0
                d.add(fid, name, "application/octet-stream", self.body["parents"][0], content=b"")
                d.items[fid]["size"] = size
                if self.media:
                    d.max_chunksize = max(d.max_chunksize, self.media.chunksize)
                    (d.resumable_names if self.media.resumable else d.simple_names).append(name)
            return {"id": fid}

    def execute(self, num_retries=0):
        assert self.resumable is None, "a resumable upload must be driven with next_chunk"
        return self._do()

    def next_chunk(self, num_retries=0):
        self.chunks += 1
        if self.chunks < 2:
            return object(), None
        return None, self._do()


class FakeFiles:
    PAGE = 3  # small pages so pagination is exercised

    def __init__(self, drive):
        self.d = drive

    def get(self, fileId, fields=None, supportsAllDrives=None):
        def fn():
            if fileId not in self.d.items:
                raise HttpError(404)
            i = self.d.items[fileId]
            out = {k: i[k] for k in ("id", "name", "mimeType", "parents")}
            if i["size"] is not None:
                out["size"] = str(i["size"])
            return out
        return Req(fn)

    def list(self, q, fields=None, pageSize=None, pageToken=None, supportsAllDrives=None, includeItemsFromAllDrives=None):
        parent = q.split("'")[1]

        def fn():
            with self.d.lock:
                kids = sorted(self.d.children(parent), key=lambda i: i["id"])
            start = int(pageToken or 0)
            page = kids[start:start + self.PAGE]
            files = []
            for i in page:
                f = {"id": i["id"], "name": i["name"], "mimeType": i["mimeType"]}
                if i["size"] is not None:
                    f["size"] = str(i["size"])
                files.append(f)
            out = {"files": files}
            if start + self.PAGE < len(kids):
                out["nextPageToken"] = str(start + self.PAGE)
            return out
        return Req(fn)

    def create(self, body, media_body=None, fields=None, supportsAllDrives=None):
        return CreateReq(self.d, body, media_body)

    def get_media(self, fileId, supportsAllDrives=None):
        return {"drive": self.d, "content": self.d.items[fileId]["content"]}


class FakeMedia:
    def __init__(self, path, mimetype, resumable, chunksize):
        self.path, self.mimetype, self.resumable, self.chunksize = path, mimetype, resumable, chunksize


class FakeDownloader:
    seen = []

    def __init__(self, fd, request, chunksize=None):
        self.fd, self.req, self.chunksize, self.pos = fd, request, chunksize, 0
        FakeDownloader.seen.append(self)

    def next_chunk(self, num_retries=0):
        hold = self.req["drive"].hold_download
        if hold is not None:
            hold.wait(10)
        step = min(self.chunksize, 64 * 1024)  # several chunks even for a small test zip
        data = self.req["content"][self.pos:self.pos + step]
        self.fd.write(data)
        self.pos += len(data)
        return None, self.pos >= len(self.req["content"])


def make_job(drive, **kw):
    sleeps = []
    kw.setdefault("zip_file_id", "zip1")
    job = ue.UnzipJob(service_factory=drive.client, media_factory=FakeMedia, downloader_cls=FakeDownloader,
                      sleep=sleeps.append, **kw)
    job.sleeps = sleeps
    return job


ENTRIES = [
    ("Takeout/Drive/a.txt", b"aaa"),
    ("Takeout/Drive/sub/b.txt", b"bbbb"),
    ("Takeout/Drive/sub/empty.txt", b""),
    ("Takeout/Mail/big.bin", b"\0" * (5 * MIB)),
    ("Takeout/readme.html", b"<html>"),
]


class UnzipJobTest(unittest.TestCase):
    def setUp(self):
        FakeDownloader.seen.clear()
        self.drive = FakeDrive()

    def test_extracts_the_tree_into_the_zips_own_folder_by_default(self):
        self.drive.add("fold", "Takeouts", FOLDER, "root")
        self.drive.add_zip(ENTRIES, parent="fold")
        st = make_job(self.drive, workers=4).run()
        self.assertEqual(st["state"], "done", st)
        self.assertEqual(st["destination"], {"id": "fold", "name": "Takeouts"})
        self.assertEqual(self.drive.tree("fold"), {
            "Takeout/Drive/a.txt": 3, "Takeout/Drive/sub/b.txt": 4, "Takeout/Drive/sub/empty.txt": 0,
            "Takeout/Mail/big.bin": 5 * MIB, "Takeout/readme.html": 6})
        self.assertEqual((st["total_files"], st["uploaded"], st["skipped"], st["failed"]), (5, 5, 0, 0))
        self.assertEqual(st["bytes_uploaded"], 3 + 4 + 6 + 5 * MIB)
        self.assertEqual(st["folders_created"], 4)
        self.assertEqual(st["progress_pct"], 100.0)
        self.assertIn("5 uploaded", st["summary"])
        self.assertEqual(st["zip"]["name"], "a.zip")

    def test_resumable_only_above_4_mib_and_chunks_are_bounded(self):
        self.drive.add_zip(ENTRIES)
        make_job(self.drive).run()
        self.assertEqual(self.drive.resumable_names, ["big.bin"])
        self.assertEqual(sorted(self.drive.simple_names), ["a.txt", "b.txt", "readme.html"])
        self.assertLessEqual(self.drive.max_chunksize, 16 * MIB)

    def test_zip_is_streamed_to_a_file_on_disk_in_chunks(self):
        self.drive.add_zip(ENTRIES + [("r.bin", os.urandom(300 * 1024))])
        job = make_job(self.drive)
        job.run()
        d = FakeDownloader.seen[0]
        self.assertNotIsInstance(d.fd, io.BytesIO)
        self.assertTrue(d.fd.name.startswith(job._work_dir), "the zip must land in the job's temp dir")
        self.assertLessEqual(d.chunksize, 16 * MIB)
        self.assertGreater(job.status()["download_bytes"], 300 * 1024)

    def test_temp_files_are_removed_and_clients_closed(self):
        self.drive.add_zip(ENTRIES)
        job = make_job(self.drive)
        job.run()
        self.assertEqual(os.listdir(job._work_dir), ["status.json"])
        self.assertTrue(all(c.closed for c in self.drive.clients))
        self.assertNotIn(job._work_dir, streaming._protected)

    def test_one_drive_client_per_thread_and_no_duplicate_folders(self):
        entries = [(f"w/d{i % 3}/deep/f{i}.txt", b"x" * (i + 1)) for i in range(60)]
        self.drive.add_zip(entries)
        st = make_job(self.drive, workers=8).run()
        self.assertEqual((st["uploaded"], st["failed"]), (60, 0))
        for c in self.drive.clients:
            self.assertLessEqual(len(c.threads), 1, "a Drive client was shared between threads")
        self.assertGreater(len(self.drive.clients), 2, "uploads must run on several worker threads")
        folders = self.drive.folders()
        self.assertEqual(len(folders), len(set(folders)), "a folder was created twice")
        self.assertEqual(len(folders), 1 + 3 + 3)

    def test_strip_wrapper_dir(self):
        self.drive.add_zip(ENTRIES)
        st = make_job(self.drive, strip_wrapper_dir=True).run()
        self.assertEqual(st["wrapper_stripped"], "Takeout")
        self.assertIn("Drive/a.txt", self.drive.tree())
        self.assertIn("readme.html", self.drive.tree())
        self.assertFalse(any(k.startswith("Takeout/") for k in self.drive.tree()))

    def test_strip_wrapper_dir_is_a_no_op_without_a_single_wrapper(self):
        self.drive.add_zip([("a/x.txt", b"1"), ("b/y.txt", b"2")])
        st = make_job(self.drive, strip_wrapper_dir=True).run()
        self.assertIsNone(st["wrapper_stripped"])
        self.assertEqual(set(self.drive.tree()), {"a/x.txt", "b/y.txt"})

    def test_explicit_destination(self):
        self.drive.add("dst", "Dest", FOLDER, "root")
        self.drive.add_zip([("x.txt", b"1")])
        make_job(self.drive, destination_folder_id="dst").run()
        self.assertEqual(self.drive.tree("dst"), {"x.txt": 1})

    def test_second_run_skips_files_already_present_with_the_same_size(self):
        self.drive.add_zip(ENTRIES)
        make_job(self.drive).run()
        before = len(self.drive.items)
        st = make_job(self.drive).run()
        self.assertEqual((st["uploaded"], st["skipped"], st["failed"], st["folders_created"]), (0, 5, 0, 0))
        self.assertEqual(len(self.drive.items), before, "a re-run must not create anything")

    def test_same_name_different_size_is_uploaded_and_skip_can_be_turned_off(self):
        self.drive.add_zip([("x.txt", b"12345")])
        self.drive.add("old", "x.txt", "text/plain", "root", content=b"1")
        st = make_job(self.drive).run()
        self.assertEqual((st["uploaded"], st["skipped"]), (1, 0))
        st = make_job(self.drive, skip_existing=False).run()
        self.assertEqual((st["uploaded"], st["skipped"]), (1, 0))

    def test_transient_failures_are_retried_with_backoff(self):
        self.drive.add_zip([("x.txt", b"1"), ("y.txt", b"2")])
        self.drive.fail["x.txt"] = [HttpError(503), ConnectionError("reset")]
        job = make_job(self.drive, workers=1)
        st = job.run()
        self.assertEqual((st["state"], st["uploaded"], st["failed"]), ("done", 2, 0))
        self.assertEqual(job.sleeps, [2.0, 4.0])

    def test_permanent_failure_is_reported_and_the_job_carries_on(self):
        self.drive.add_zip([("x.txt", b"1"), ("y.txt", b"2")])
        self.drive.fail["x.txt"] = [HttpError(404)] * 9
        job = make_job(self.drive, workers=1)
        st = job.run()
        self.assertEqual((st["state"], st["uploaded"], st["failed"]), ("done_with_failures", 1, 1))
        self.assertEqual(st["failures"][0]["path"], "x.txt")
        self.assertIn("404", st["failures"][0]["error"])
        self.assertEqual(job.sleeps, [], "a 404 must not be retried")
        self.assertEqual(os.listdir(job._work_dir), ["status.json"])

    def test_a_member_that_escapes_the_destination_is_refused(self):
        self.drive.add_zip([("../evil.txt", b"1"), ("ok.txt", b"2")])
        st = make_job(self.drive).run()
        self.assertEqual((st["uploaded"], st["failed"], st["total_files"]), (1, 1, 2))
        self.assertEqual(set(self.drive.tree()), {"ok.txt"})
        self.assertIn("unsafe", st["failures"][0]["error"])

    def test_not_a_zip_fails_with_a_clear_error_and_cleans_up(self):
        self.drive.add("zip1", "notes.txt", "text/plain", "root", content=b"hello")
        job = make_job(self.drive)
        st = job.run()
        self.assertEqual(st["state"], "failed")
        self.assertIn("not a zip", st["error"])
        self.assertEqual(os.listdir(job._work_dir), ["status.json"])

    def test_bad_inputs(self):
        self.drive.add("zip1", "Folder", FOLDER, "root")
        self.assertIn("folder, not a zip", make_job(self.drive).run()["error"])
        self.drive.add("doc", "Doc", "application/vnd.google-apps.document", "root")
        self.assertIn("no binary content", make_job(self.drive, zip_file_id="doc").run()["error"])
        self.drive.add_zip([("x", b"1")], fid="z2")
        self.drive.add("file", "f.txt", "text/plain", "root", content=b"1")
        self.assertIn("is not a folder", make_job(self.drive, zip_file_id="z2", destination_folder_id="file").run()["error"])

    def test_no_room_is_refused_before_downloading(self):
        self.drive.add_zip(ENTRIES)
        saved = streaming.TMP_QUOTA_BYTES
        streaming.TMP_QUOTA_BYTES = 10
        try:
            st = make_job(self.drive).run()
        finally:
            streaming.TMP_QUOTA_BYTES = saved
        self.assertEqual(st["state"], "failed")
        self.assertIn("quota", st["error"])
        self.assertEqual(FakeDownloader.seen, [])

    def test_helpers(self):
        self.assertEqual(ue.safe_parts("a//b/./c.txt"), ["a", "b", "c.txt"])
        self.assertEqual(ue.safe_parts("a\\b.txt"), ["a", "b.txt"])
        self.assertIsNone(ue.safe_parts("a/../../b"))
        self.assertIsNone(ue.safe_parts("/"))
        self.assertEqual(ue.common_wrapper([["w", "a"], ["w", "b", "c"]]), "w")
        self.assertIsNone(ue.common_wrapper([["w", "a"], ["loose"]]))


class BackgroundJobTest(unittest.TestCase):
    def setUp(self):
        FakeDownloader.seen.clear()
        ue._jobs.clear()
        self.drive = FakeDrive()
        self.drive.add_zip(ENTRIES)
        self.kw = dict(zip_file_id="zip1", service_factory=self.drive.client, media_factory=FakeMedia,
                       downloader_cls=FakeDownloader)

    def _wait(self, job, timeout=20):
        end = time.time() + timeout
        while not job.finished and time.time() < end:
            time.sleep(0.01)
        self.assertTrue(job.finished, job.status())

    def test_start_returns_at_once_and_status_reports_progress_then_summary(self):
        self.drive.hold_download = threading.Event()
        t0 = time.time()
        job = ue.start_job(**self.kw)
        self.assertLess(time.time() - t0, 1.0, "start must not wait for the work")
        time.sleep(0.1)
        st = ue.job_status(job.job_id)
        self.assertEqual((st["state"], st["phase"]), ("running", "downloading"))
        self.assertIsNone(st["summary"])
        self.assertEqual(ue.jobs_summary()["active"], 1)
        with self.assertRaises(ue.UnzipError) as cm:  # one job at a time
            ue.start_job(**self.kw)
        self.assertIn(job.job_id, str(cm.exception))
        self.drive.hold_download.set()
        self._wait(job)
        st = ue.job_status(job.job_id)
        self.assertEqual((st["state"], st["uploaded"]), ("done", 5))
        self.assertIn("done: 5 uploaded", st["summary"])
        self.assertEqual(ue.jobs_summary(), {"active": 0, "finished": 1, "limit": ue.MAX_ACTIVE_JOBS})
        self.assertEqual([j["job_id"] for j in ue.list_jobs()], [job.job_id])

    def test_cancel(self):
        self.drive.hold_download = threading.Event()
        job = ue.start_job(**self.kw)
        time.sleep(0.05)
        job.cancel()
        self.drive.hold_download.set()
        self._wait(job)
        st = job.status()
        self.assertEqual(st["state"], "cancelled")
        self.assertEqual(st["uploaded"], 0)
        self.assertEqual(os.listdir(job._work_dir), ["status.json"])

    def test_status_survives_a_restart_as_interrupted(self):
        job = ue.start_job(**self.kw)
        self._wait(job)
        ue._jobs.clear()  # a new process has an empty registry
        self.assertEqual(ue.job_status(job.job_id)["state"], "done")
        import json
        path = os.path.join(job._work_dir, "status.json")
        with open(path) as fh:
            st = json.load(fh)
        st["state"] = "running"
        with open(path, "w") as fh:
            json.dump(st, fh)
        st = ue.job_status(job.job_id)
        self.assertEqual(st["state"], "interrupted")
        self.assertIn("skip_existing", st["error"])
        self.assertIsNone(ue.job_status("../../etc/passwd"))
        self.assertIsNone(ue.job_status("0123456789ab"))


if __name__ == "__main__":
    unittest.main()
