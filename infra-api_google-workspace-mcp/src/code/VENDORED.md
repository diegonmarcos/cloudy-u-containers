# Vendored upstream — google_workspace_mcp

| | |
|---|---|
| Upstream | https://github.com/taylorwilsdon/google_workspace_mcp |
| Version | 1.14.3 (from `pyproject.toml`) |
| Pin | tag `v1.14.3` = commit `92b4a7847fa78713e98ffe9562a5adee2c926ec7` |
| Licence | MIT (`LICENSE`, kept) |

The pin is inferred from the vendored `pyproject.toml` version and resolved with
`git ls-remote` on 2026-10-03 (#839); the original vendoring did not record a
commit. Differences against it are measured in `licenses/provenance/google-workspace-mcp.tsv`.

Against this inferred base the tree has 23 modified and 16 new files (provenance TSV,
re-measured 2026-11-11 for #1659: `core/streaming.py`, `gdrive/unzip_engine.py` and
`tests/stability/` are new; the Drive download/upload paths in `gdrive/drive_tools.py`,
`core/attachment_storage.py` and the `/health` route in `core/server.py` are modified).
Whether those are owner edits or the vendoring was taken from a commit near, but not at,
`v1.14.3` is not recorded; all of it stays MIT.
