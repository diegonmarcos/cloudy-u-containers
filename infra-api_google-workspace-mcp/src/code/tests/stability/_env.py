"""Shared set-up for the #1659 stability tests: standard library only, no Google packages."""
import atexit
import os
import shutil
import sys
import tempfile

CODE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if CODE not in sys.path:
    sys.path.insert(0, CODE)

TMP = tempfile.mkdtemp(prefix="wsmcp-test-")
os.environ["WORKSPACE_MCP_TMP_DIR"] = os.path.join(TMP, "tmp")
os.environ["WORKSPACE_ATTACHMENT_DIR"] = os.path.join(TMP, "attachments")
# The reserve protects the fleet's shared disk in production; a test must not depend on how
# full the machine that runs it happens to be.
os.environ["WORKSPACE_MCP_DISK_RESERVE_BYTES"] = "0"
atexit.register(shutil.rmtree, TMP, ignore_errors=True)

from core import streaming  # noqa: E402

streaming.DISK_RESERVE_BYTES = 0  # also when another test module imported it first
