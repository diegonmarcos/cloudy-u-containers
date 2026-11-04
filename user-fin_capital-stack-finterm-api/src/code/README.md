# fincept-rs

Pure Rust port of [Fincept Terminal](https://github.com/Fincept-Corporation/FinceptTerminal) — a Bloomberg-class financial intelligence platform. Single static binary, egui UI, no Python, no Qt runtime.

**Status**: Phase 0 — scaffolding. See `docs/MIGRATION.md`.

## Quick start

```bash
./build.sh build     # cargo build --workspace (release)
./build.sh test      # cargo test --workspace + coverage gate
./build.sh lint      # fmt + clippy -D warnings
./build.sh registry  # print crate registry summary
./build.sh help      # all actions
```

## Layout

- `build.sh` — universal engine (data-driven via `build.json` + `modules.json`)
- `build.json` — project config (binary name, packaging targets, secrets)
- `modules.json` — single source of truth for connectors/brokers/analytics/agents
- `app/` — `fincept` binary crate
- `crates/` — library crates (grouped: `data/`, `brokers/`, `analytics/`, `ml/`, `agents/`, `ui/`, plus top-level infrastructure)
- `tests/parity/` — C++/Python vs Rust golden-file tests
- `tests/e2e/` — screen-level end-to-end tests
- `docs/` — architecture + migration tracker

## License

AGPL-3.0-or-later, matching upstream. Commercial licensing: see upstream.
