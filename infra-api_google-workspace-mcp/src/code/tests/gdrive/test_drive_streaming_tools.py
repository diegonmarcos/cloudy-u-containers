"""
#1659: the Drive tools themselves, with a mocked Drive service. The download must be driven
chunk by chunk through MediaIoBaseDownload into a file on disk, and reach the attachment
store as a file. Needs the server's dependencies (run with the project venv).
"""
import io
import os
import sys
from unittest.mock import Mock, patch

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "../..")))

from googleapiclient.http import MediaIoBaseDownload as RealDownloader  # noqa: E402  (before the fixture patches it)

from core import streaming  # noqa: E402
from gdrive import drive_tools  # noqa: E402

MIB = 1024 * 1024


def _unwrap(tool):
    fn = tool.fn if hasattr(tool, "fn") else tool
    while hasattr(fn, "__wrapped__"):
        fn = fn.__wrapped__
    return fn


class Downloader:
    """Records how googleapiclient's MediaIoBaseDownload is used."""

    made = []

    def __init__(self, fd, request, chunksize=None):
        self.fd, self.total, self.chunksize, self.sent, self.calls = fd, request.total, chunksize, 0, 0
        Downloader.made.append(self)

    def next_chunk(self, num_retries=0):
        self.calls += 1
        n = min(self.chunksize, self.total - self.sent)
        self.fd.write(b"z" * n)
        self.sent += n
        return None, self.sent >= self.total


def _service(meta, total):
    service = Mock()
    service.files().get().execute.return_value = meta
    service.files().get_media.return_value = Mock(total=total)
    service.files().export_media.return_value = Mock(total=total)
    return service


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    Downloader.made.clear()
    monkeypatch.setenv("WORKSPACE_MCP_TMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setattr(streaming, "DISK_RESERVE_BYTES", 0)  # not a property of the test machine's disk
    monkeypatch.setattr("core.attachment_storage.STORAGE_DIR", tmp_path / "att")
    monkeypatch.setattr("core.attachment_storage._attachment_storage", None)
    monkeypatch.setattr("googleapiclient.http.MediaIoBaseDownload", Downloader)
    yield


@pytest.mark.asyncio
async def test_download_url_streams_a_large_file_to_disk_in_chunks(tmp_path):
    total = 40 * MIB
    service = _service({"id": "f1", "name": "takeout.zip", "mimeType": "application/zip", "size": str(total)}, total)
    with patch.object(drive_tools, "get_transport_mode", return_value="streamable-http"):
        out = await _unwrap(drive_tools.get_drive_file_download_url)(service, "me@example.com", "f1")
    d = Downloader.made[0]
    assert d.calls == total // streaming.DOWNLOAD_CHUNK_BYTES, "one next_chunk per chunk"
    assert d.chunksize <= 16 * MIB
    assert not isinstance(d.fd, io.BytesIO), "the download sink must be a file on disk"
    assert str(d.fd.name).startswith(str(tmp_path / "tmp"))
    assert f"({total} bytes)" in out and "Download URL" in out
    stored = list((tmp_path / "att").iterdir())
    assert len(stored) == 1 and stored[0].stat().st_size == total and stored[0].suffix == ".zip"
    assert list((tmp_path / "tmp").iterdir()) == [], "the temp file is moved into the store, not left behind"


@pytest.mark.asyncio
async def test_content_refuses_a_huge_file_without_downloading_it():
    size = streaming.MAX_TEXT_BYTES + 1
    service = _service({"id": "f1", "name": "big.zip", "mimeType": "application/zip", "size": str(size)}, size)
    out = await _unwrap(drive_tools.get_drive_file_content)(service, "me@example.com", "f1")
    assert out.startswith("Error:") and "get_drive_file_download_url" in out and str(size) in out
    assert Downloader.made == [], "nothing may be downloaded for a file over the text limit"


@pytest.mark.asyncio
async def test_content_aborts_an_export_that_grows_past_the_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(drive_tools, "MAX_TEXT_BYTES", 1 * MIB)
    service = _service({"id": "d1", "name": "Doc", "mimeType": "application/vnd.google-apps.document"}, 64 * MIB)
    out = await _unwrap(drive_tools.get_drive_file_content)(service, "me@example.com", "d1")
    assert out.startswith("Error:")
    assert Downloader.made[0].sent <= 1 * MIB + streaming.DOWNLOAD_CHUNK_BYTES, "must stop at the first chunk past the limit"
    assert list((tmp_path / "tmp").iterdir()) == []


@pytest.mark.asyncio
async def test_content_still_returns_small_text(tmp_path):
    service = _service({"id": "f1", "name": "n.txt", "mimeType": "text/plain", "size": "5", "webViewLink": "L"}, 5)
    out = await _unwrap(drive_tools.get_drive_file_content)(service, "me@example.com", "f1")
    assert out.endswith("--- CONTENT ---\nzzzzz")
    assert list((tmp_path / "tmp").iterdir()) == []


@pytest.mark.asyncio
async def test_folder_zip_is_built_on_disk(tmp_path):
    service = Mock()
    service.files().get().execute.return_value = {"name": "Photos"}
    service.files().list().execute.return_value = {"files": [
        {"id": "a", "name": "a.bin", "mimeType": "application/octet-stream", "size": str(3 * MIB)},
        {"id": "b", "name": "b.bin", "mimeType": "application/octet-stream", "size": str(2 * MIB)},
    ]}
    service.files().get_media.side_effect = lambda fileId, supportsAllDrives=None: Mock(total={"a": 3, "b": 2}[fileId] * MIB)
    out = await _unwrap(drive_tools.download_drive_folder_as_zip)(service, "me@example.com", "folder1")
    assert "→ 2 files" in out, out
    assert all(not isinstance(d.fd, io.BytesIO) for d in Downloader.made) and len(Downloader.made) == 2
    stored = list((tmp_path / "att").iterdir())
    assert len(stored) == 1 and stored[0].name.startswith("Photos_")
    import zipfile
    with zipfile.ZipFile(stored[0]) as zf:
        assert sorted((i.filename, i.file_size) for i in zf.infolist()) == [("a.bin", 3 * MIB), ("b.bin", 2 * MIB)]
    assert list((tmp_path / "tmp").iterdir()) == []


@pytest.mark.asyncio
async def test_create_from_file_url_uploads_from_disk(tmp_path, monkeypatch):
    src = tmp_path / "big.bin"
    src.write_bytes(b"x" * (6 * MIB))
    monkeypatch.setattr(drive_tools, "validate_file_path", lambda p: src)
    monkeypatch.setattr(drive_tools, "resolve_folder_id", _async_return("root"))
    service = Mock()
    request = Mock()
    request.resumable = object()
    request.next_chunk.side_effect = [(Mock(), None), (None, {"id": "new", "name": "big.bin", "webViewLink": "L"})]
    service.files().create.return_value = request
    out = await _unwrap(drive_tools.create_drive_file)(service, "me@example.com", "big.bin", fileUrl=src.as_uri())
    assert "Successfully created file 'big.bin'" in out
    media = service.files().create.call_args.kwargs["media_body"]
    assert type(media).__name__ == "MediaFileUpload" and media.resumable() and media.chunksize() <= 16 * MIB
    assert request.next_chunk.call_count == 2 and not request.execute.called, "a resumable upload goes chunk by chunk"


def _async_return(value):
    async def fn(*a, **k):
        return value
    return fn


def test_real_media_downloader_issues_one_ranged_request_per_chunk(tmp_path):
    """The real googleapiclient MediaIoBaseDownload, fed by a fake HTTP layer: Range requests of
    the chunk size, written straight to the file."""
    import httplib2

    total, chunk = 5 * MIB + 123, 2 * MIB
    ranges = []

    class Http:
        def request(self, uri, method="GET", headers=None, **kw):
            start, end = (int(x) for x in headers["range"].split("=")[1].split("-"))
            end = min(end, total - 1)
            ranges.append((start, end))
            resp = httplib2.Response({"status": "206", "content-range": f"bytes {start}-{end}/{total}",
                                      "content-length": str(end - start + 1)})
            return resp, b"q" * (end - start + 1)

    request = Mock(uri="https://example.invalid/file?alt=media", headers={}, http=Http())
    dest = tmp_path / "out.bin"
    size = streaming.download_to_file(request, dest, chunk_bytes=chunk, downloader_cls=RealDownloader)
    assert size == total and dest.stat().st_size == total
    assert ranges == [(0, chunk - 1), (chunk, 2 * chunk - 1), (2 * chunk, total - 1)]
    assert max(e - s + 1 for s, e in ranges) <= 16 * MIB
