"""
#1659 source contract for gdrive/drive_tools.py (parsed, not imported, so it runs with no
Google packages): no Drive download may target a memory buffer, and the unzip methods are
reachable through the grouped workspace_drive tool at the tier this deployment runs.
"""
import ast
import os
import re
import unittest

try:
    from . import _env
except ImportError:
    import _env

CODE = _env.CODE


def read(rel):
    with open(os.path.join(CODE, rel)) as fh:
        return fh.read()


class DriveToolsContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = read("gdrive/drive_tools.py")
        cls.tree = ast.parse(cls.src)
        cls.funcs = {n.name: n for n in ast.walk(cls.tree) if isinstance(n, (ast.AsyncFunctionDef, ast.FunctionDef))}

    def calls(self, func):
        """Every name a function references (called directly or handed to to_thread)."""
        out = set()
        for n in ast.walk(self.funcs[func]):
            if isinstance(n, ast.Name):
                out.add(n.id)
            elif isinstance(n, ast.Attribute):
                out.add(n.attr)
        return out

    def test_no_download_into_memory_anywhere(self):
        names = {n.id for n in ast.walk(self.tree) if isinstance(n, ast.Name)} | \
                {n.attr for n in ast.walk(self.tree) if isinstance(n, ast.Attribute)}
        self.assertNotIn("MediaIoBaseDownload", names, "downloads go through core.streaming.download_to_file")
        self.assertNotIn("getvalue", names, "a BytesIO read back with getvalue() is a whole file in memory")
        self.assertNotIn("content", {n.attr for n in ast.walk(self.tree)
                                     if isinstance(n, ast.Attribute) and isinstance(n.value, ast.Name) and n.value.id == "resp"},
                         "resp.content loads a whole HTTP body")

    def test_every_download_path_streams_to_disk(self):
        self.assertIn("download_to_file", self.calls("_stream_media_to_tmp"))
        for fn in ("get_drive_file_download_url", "get_drive_file_content"):
            self.assertIn("_stream_media_to_tmp", self.calls(fn), fn)
            self.assertIn("heavy_slot", self.calls(fn), fn)
        zip_calls = self.calls("download_drive_folder_as_zip")
        self.assertIn("download_to_file", zip_calls)
        self.assertIn("heavy_slot", zip_calls)
        self.assertNotIn("writestr", zip_calls, "zip members are added from files on disk")
        self.assertNotIn("BytesIO", zip_calls)

    def test_downloads_reach_the_attachment_store_as_files(self):
        for fn in ("get_drive_file_download_url", "download_drive_folder_as_zip"):
            body = ast.get_source_segment(self.src, self.funcs[fn])
            self.assertIn("save_file", body, fn)
            self.assertNotIn("save_attachment", body, f"{fn}: save_attachment takes base64 of the whole file")
            self.assertNotIn("b64encode(file_content_bytes", body, fn)

    def test_text_read_has_a_size_guard_before_the_download(self):
        body = ast.get_source_segment(self.src, self.funcs["get_drive_file_content"])
        self.assertLess(body.index("declared > MAX_TEXT_BYTES"), body.index("_stream_media_to_tmp"))
        self.assertIn("max_bytes=MAX_TEXT_BYTES", body)

    def test_uploads_from_file_url_read_from_disk(self):
        body = ast.get_source_segment(self.src, self.funcs["create_drive_file"])
        self.assertNotIn("read_bytes", body)
        self.assertIn("_upload_file_media", body)   # file://
        self.assertIn("_ssrf_safe_stream", body)    # http(s)://
        self.assertNotIn("_ssrf_safe_fetch", body)
        self.assertIn("MediaFileUpload", self.calls("_upload_file_media"))

    def test_chunk_constants_are_at_most_16_mib(self):
        for name in ("DOWNLOAD_CHUNK_SIZE_BYTES", "UPLOAD_CHUNK_SIZE_BYTES"):
            m = re.search(rf"^{name} = (.+?)(?:  #.*)?$", self.src, re.M)
            self.assertIsNotNone(m, name)
            self.assertLessEqual(eval(m.group(1), {}), 16 * 1024 * 1024, name)  # noqa: S307 - arithmetic literal

    def test_unzip_methods_are_exposed(self):
        methods = ("start_drive_unzip", "get_drive_unzip_status", "cancel_drive_unzip")
        for m in methods:
            self.assertIn(m, self.funcs, f"{m} is not defined in gdrive/drive_tools.py")
        meta = ast.parse(read("core/meta.py"))
        groups = next(ast.literal_eval(n.value) for n in meta.body
                      if isinstance(n, ast.Assign) and n.targets[0].id == "GROUPS")
        tiers = read("core/tool_tiers.yaml")
        drive_tier = tiers[tiers.index("\ndrive:"):tiers.index("\ncalendar:")]
        for m in methods:
            self.assertIn(m, groups["workspace_drive"], f"{m} missing from the grouped workspace_drive tool")
            self.assertIn(f"- {m}\n", drive_tier, f"{m} missing from core/tool_tiers.yaml (drive)")
        start = ast.get_source_segment(self.src, self.funcs["start_drive_unzip"])
        self.assertIn("start_job", start)
        self.assertNotIn("await asyncio.to_thread(job.run", start, "start must not wait for the job")

    def test_health_endpoint_reports_headroom_and_cleans_up(self):
        server = read("core/server.py")
        body = server[server.index("async def health_check"):server.index('@server.custom_route("/attachments')]
        for needle in ("health_snapshot", "cleanup_expired", "sweep_tmp", "jobs_summary"):
            self.assertIn(needle, body)


if __name__ == "__main__":
    unittest.main()
