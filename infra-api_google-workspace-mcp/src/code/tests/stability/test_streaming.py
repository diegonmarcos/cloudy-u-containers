# ruff: noqa: E702
"""#1659: a Drive download is chunked into a file; nothing holds the whole file."""
import asyncio
import io
import os
import tempfile
import time
import tracemalloc
import unittest

try:
    from . import _env  # noqa: F401
except ImportError:  # run as a script / unittest discover from this directory
    import _env  # noqa: F401

from core import streaming

MIB = 1024 * 1024


class FakeDownloader:
    """Stands in for googleapiclient's MediaIoBaseDownload: same constructor and next_chunk."""

    instances = []

    def __init__(self, fd, request, chunksize=None):
        self.fd, self.total, self.chunksize, self.sent, self.calls = fd, request["size"], chunksize, 0, 0
        FakeDownloader.instances.append(self)

    def next_chunk(self, num_retries=0):
        self.calls += 1
        n = min(self.chunksize, self.total - self.sent)
        self.fd.write(b"\0" * n)
        self.sent += n
        return None, self.sent >= self.total


class DownloadToFile(unittest.TestCase):
    def setUp(self):
        FakeDownloader.instances.clear()
        self.dest = str(streaming.new_tmp_path("t"))

    def tearDown(self):
        streaming.remove_quietly(self.dest)

    def test_writes_to_a_real_file_in_chunks(self):
        size = streaming.download_to_file({"size": 40 * MIB}, self.dest, chunk_bytes=8 * MIB, downloader_cls=FakeDownloader)
        d = FakeDownloader.instances[0]
        self.assertEqual(size, 40 * MIB)
        self.assertEqual(os.path.getsize(self.dest), 40 * MIB)
        self.assertEqual(d.calls, 5, "one API call per chunk")
        self.assertNotIsInstance(d.fd, io.BytesIO, "the sink must be a file on disk, never a memory buffer")
        self.assertEqual(os.path.realpath(d.fd.name), os.path.realpath(self.dest))

    def test_chunk_is_capped_at_16_mib(self):
        streaming.download_to_file({"size": 1}, self.dest, chunk_bytes=512 * MIB, downloader_cls=FakeDownloader)
        self.assertEqual(FakeDownloader.instances[0].chunksize, 16 * MIB)
        self.assertLessEqual(streaming.DOWNLOAD_CHUNK_BYTES, 16 * MIB)
        self.assertLessEqual(streaming.UPLOAD_CHUNK_BYTES, 16 * MIB)

    def test_memory_stays_bounded_for_a_large_file(self):
        tracemalloc.start()
        try:
            streaming.download_to_file({"size": 96 * MIB}, self.dest, chunk_bytes=8 * MIB, downloader_cls=FakeDownloader)
            _cur, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertLess(peak, 24 * MIB, f"peak {peak} bytes for a 96 MiB download: the file is being held in memory")

    def test_limit_aborts_and_removes_the_partial_file(self):
        with self.assertRaises(streaming.TooLargeError):
            streaming.download_to_file({"size": 40 * MIB}, self.dest, chunk_bytes=8 * MIB, max_bytes=10 * MIB, downloader_cls=FakeDownloader)
        self.assertFalse(os.path.exists(self.dest))
        self.assertLessEqual(FakeDownloader.instances[0].calls, 2, "must stop at the first chunk past the limit")

    def test_failure_removes_the_partial_file(self):
        class Boom(FakeDownloader):
            def next_chunk(self, num_retries=0):
                self.fd.write(b"x")
                raise RuntimeError("network")

        with self.assertRaises(RuntimeError):
            streaming.download_to_file({"size": 9}, self.dest, downloader_cls=Boom)
        self.assertFalse(os.path.exists(self.dest))


class TempDir(unittest.TestCase):
    def test_sweep_removes_only_old_unprotected_entries(self):
        d = streaming.tmp_dir()
        old, fresh, kept = d / "old.bin", d / "fresh.bin", d / "job"
        old.write_bytes(b"1"); fresh.write_bytes(b"2"); kept.mkdir(exist_ok=True); (kept / "f").write_bytes(b"3")
        past = time.time() - 10_000
        os.utime(old, (past, past)); os.utime(kept, (past, past))
        streaming.protect_tmp(kept)
        self.assertEqual(streaming.sweep_tmp(max_age_seconds=3600), 1)
        self.assertFalse(old.exists()); self.assertTrue(fresh.exists()); self.assertTrue(kept.exists())
        streaming.unprotect_tmp(kept)
        self.assertEqual(streaming.sweep_tmp(max_age_seconds=3600), 1)
        self.assertFalse(kept.exists())
        fresh.unlink()

    def test_quota_refuses_with_a_clear_message(self):
        saved = streaming.TMP_QUOTA_BYTES
        streaming.TMP_QUOTA_BYTES = 10
        try:
            with self.assertRaises(streaming.TooLargeError) as cm:
                streaming.ensure_room(11, "The zip")
            self.assertIn("quota", str(cm.exception))
        finally:
            streaming.TMP_QUOTA_BYTES = saved

    def test_disk_reserve_is_respected(self):
        saved = streaming.TMP_QUOTA_BYTES
        streaming.TMP_QUOTA_BYTES = 1 << 62
        try:
            with self.assertRaises(streaming.TooLargeError) as cm:
                streaming.ensure_room(1 << 60, "The zip")
            self.assertIn("free on the disk", str(cm.exception))
        finally:
            streaming.TMP_QUOTA_BYTES = saved


class HeavySlots(unittest.TestCase):
    def test_at_most_limit_run_at_once_and_a_waiter_gets_a_busy_error(self):
        async def main():
            peak = 0
            running = 0

            async def work():
                nonlocal peak, running
                async with streaming.heavy_slot("t", wait_seconds=5):
                    running += 1
                    peak = max(peak, running)
                    await asyncio.sleep(0.05)
                    running -= 1

            await asyncio.gather(*[work() for _ in range(streaming.HEAVY_CONCURRENCY * 3)])
            self.assertEqual(peak, streaming.HEAVY_CONCURRENCY)

            hold = asyncio.Event()

            async def holder():
                async with streaming.heavy_slot("hold"):
                    await hold.wait()

            tasks = [asyncio.create_task(holder()) for _ in range(streaming.HEAVY_CONCURRENCY)]
            await asyncio.sleep(0.01)
            self.assertEqual(streaming.heavy_stats()["active"], streaming.HEAVY_CONCURRENCY)
            with self.assertRaises(streaming.BusyError):
                async with streaming.heavy_slot("late", wait_seconds=0.05):
                    pass
            hold.set()
            await asyncio.gather(*tasks)
            self.assertEqual(streaming.heavy_stats()["active"], 0)

        asyncio.run(main())


class MemoryHeadroom(unittest.TestCase):
    def _root(self, files):
        root = tempfile.mkdtemp(prefix="cg-")
        for rel, text in files.items():
            p = os.path.join(root, rel)
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w") as fh:
                fh.write(text)
        return root

    def test_cgroup_v2_limit(self):
        root = self._root({
            "sys/fs/cgroup/memory.max": "2147483648\n",
            "sys/fs/cgroup/memory.current": "1610612736\n",
            "sys/fs/cgroup/memory.stat": "anon 5\ninactive_file 536870912\n",
        })
        m = streaming.memory_headroom(root)
        self.assertEqual(m["source"], "cgroup-v2")
        self.assertTrue(m["limited"])
        self.assertEqual(m["limit_bytes"], 2 * 1024 ** 3)
        self.assertEqual(m["headroom_bytes"], 1024 ** 3)  # 2G - (1.5G - 0.5G reclaimable cache)
        self.assertEqual(m["headroom_pct"], 50.0)
        self.assertFalse(m["low"])

    def test_low_flag(self):
        root = self._root({"sys/fs/cgroup/memory.max": "1000\n", "sys/fs/cgroup/memory.current": "900\n"})
        self.assertTrue(streaming.memory_headroom(root)["low"])

    def test_no_limit_falls_back_to_host_available(self):
        root = self._root({
            "sys/fs/cgroup/memory.max": "max\n",
            "sys/fs/cgroup/memory.current": "100\n",
            "proc/meminfo": "MemTotal:       1000 kB\nMemAvailable:    400 kB\n",
        })
        m = streaming.memory_headroom(root)
        self.assertFalse(m["limited"])
        self.assertEqual(m["headroom_bytes"], 400 * 1024)

    def test_cgroup_v1(self):
        root = self._root({
            "sys/fs/cgroup/memory/memory.limit_in_bytes": "1000\n",
            "sys/fs/cgroup/memory/memory.usage_in_bytes": "250\n",
        })
        m = streaming.memory_headroom(root)
        self.assertEqual((m["source"], m["headroom_bytes"]), ("cgroup-v1", 750))

    def test_health_snapshot_shape(self):
        snap = streaming.health_snapshot()
        self.assertIn("headroom_bytes", snap["memory"])
        self.assertEqual(snap["heavy_calls"]["limit"], streaming.HEAVY_CONCURRENCY)
        self.assertIn("used_bytes", snap["tmp"])


if __name__ == "__main__":
    unittest.main()
