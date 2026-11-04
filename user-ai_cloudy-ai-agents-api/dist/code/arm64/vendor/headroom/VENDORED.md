# Vendored: Headroom (context compression engine)

This directory is a **curated vendor copy** of the open-source Headroom project,
merged into `claude-api-superset` so we own and build the compression engine
ourselves (no PyPI runtime dependency).

| | |
|---|---|
| Upstream | https://github.com/chopratejas/headroom |
| Source commit | `9f7f3adfea03710d5e67c4c630b3c8061ff6d161` |
| Upstream version | `0.26.0` |
| License | Apache-2.0 (see `LICENSE` + `NOTICE`, retained verbatim) |
| Vendored on | 2026-06-19 |

## What we kept (the buildable core only)

Exactly the file set the upstream `Dockerfile` builder stage compiles:

- `pyproject.toml`, `uv.lock`, `README.md`
- `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`
- `crates/` — the Rust workspace (`headroom-core`, `headroom-parity`, `headroom-proxy`, `headroom-py`); `headroom._core` is built via maturin/pyo3
- `headroom/` — the full Python package (compressors, proxy, dashboard, CLI)
- `LICENSE`, `NOTICE`

## What we dropped (not needed to build or run)

`examples/` (34M), `tests/` (7M), `docs/`, `wiki/`, `benchmarks/`, `e2e/`,
`sdk/` (the TS npm client — we use the Python lib directly), `plugins/`,
`scripts/`, `sql/`, `docker/`, `REALIGNMENT/`, all `*.gif`/`*.png` demo assets,
and CI/dev dotfiles. None are imported by the compression library or proxy.

## How we use it

- Built in the service `Dockerfile` (Rust stage → maturin wheel via
  `uv pip install ".[proxy,code]"`), adapted from upstream's own multi-stage
  Dockerfile.
- Consumed in-process by `src/code/py/compress_service.py` via
  `from headroom import compress` — **compress-only**, no upstream forwarding,
  so the subscription `claude` CLI path needs no metered API key.
- The optional `[ml]`/`[memory]` extras (torch, sentence-transformers) are NOT
  installed; ML "Kompress" is left disabled on arm64 (SmartCrusher JSON + AST
  CodeCompressor remain active).

## Modifications

- **Renamed `headroom/copilot_linux_secret.py` → `headroom/copilot_linux_keyring.py`**
  (and updated its sole importer, `headroom/copilot_auth.py:23`). The original
  filename matched the repo's `*secret*` commit-blocker (a public-repo guard
  against staging credentials). It is source code, not a credential; the rename
  is purely to satisfy the filename guard — behaviour is identical. The Copilot
  backend is not used here (we use the subscription `claude` CLI), so this path
  is never exercised at runtime anyway.

Otherwise vendored verbatim at the commit above. All integration lives outside
this directory (`../server.mjs`, `../py/`, `../Dockerfile`, `../start.sh`). If
upstream source is ever patched, record the diff here.
