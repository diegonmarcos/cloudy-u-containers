# ruff: noqa: E702
"""#1659: attachments are adopted from disk without a memory copy, and expired files are removed."""
import os
import time
import unittest

try:
    from . import _env  # noqa: F401
except ImportError:
    import _env  # noqa: F401

from core import attachment_storage as att


class AttachmentExpiry(unittest.TestCase):
    def setUp(self):
        att._ensure_storage_dir()
        for f in att.STORAGE_DIR.iterdir():
            f.unlink()
        self.store = att.AttachmentStorage(expiration_seconds=3600)

    def _src(self, data=b"zipdata"):
        p = att.STORAGE_DIR.parent / f"src-{time.time_ns()}"
        p.write_bytes(data)
        return p

    def test_save_file_moves_the_file_and_never_takes_bytes(self):
        src = self._src(b"x" * 1000)
        saved = self.store.save_file(src, filename="takeout.zip", mime_type="application/zip")
        self.assertFalse(src.exists(), "the temp file is moved, not copied")
        self.assertEqual(os.path.getsize(saved.path), 1000)
        self.assertEqual(oct(os.stat(saved.path).st_mode & 0o777), "0o600")
        meta = self.store.get_attachment_metadata(saved.file_id)
        self.assertEqual((meta["filename"], meta["mime_type"], meta["size"]), ("takeout.zip", "application/zip", 1000))
        self.assertEqual(str(self.store.get_attachment_path(saved.file_id)), saved.path)

    def test_a_hostile_filename_stays_inside_the_store(self):
        saved = self.store.save_file(self._src(), filename="../../etc/cron.d/x.zip")
        self.assertEqual(os.path.dirname(saved.path), str(att.STORAGE_DIR))

    def test_expired_tracked_file_is_deleted_from_disk(self):
        saved = self.store.save_file(self._src(), filename="a.bin")
        self.store._metadata[saved.file_id]["expires_at"] = att.datetime.now() - att.timedelta(seconds=1)
        self.assertEqual(self.store.cleanup_expired(), 1)
        self.assertFalse(os.path.exists(saved.path))
        self.assertIsNone(self.store.get_attachment_path(saved.file_id))

    def test_orphans_from_a_previous_process_are_deleted_once_old(self):
        old, fresh = att.STORAGE_DIR / "orphan-old.zip", att.STORAGE_DIR / "orphan-fresh.zip"
        old.write_bytes(b"1"); fresh.write_bytes(b"2")
        past = time.time() - 7200
        os.utime(old, (past, past))
        live = self.store.save_file(self._src(), filename="live.bin")  # saving also sweeps
        self.assertFalse(old.exists(), "a file older than the expiry that nothing tracks must go")
        self.assertTrue(fresh.exists())
        self.assertTrue(os.path.exists(live.path))

    def test_bytes_path_still_works_and_sweeps(self):
        import base64
        saved = self.store.save_attachment(base64.urlsafe_b64encode(b"hello").decode(), filename="h.txt")
        with open(saved.path, "rb") as fh:
            self.assertEqual(fh.read(), b"hello")


if __name__ == "__main__":
    unittest.main()
