# Architecture

## Principles

1. **Single binary** — no Python, no Qt, no Electron. Static-linked where possible.
2. **Data-driven registry** — `modules.json` is the one place that lists every connector, broker, analytics module, ML crate, and agent. `build.sh` reads it to sync workspace membership, generate CI matrices, and enforce coverage.
3. **Declarative build** — every action (`build`, `test`, `ship`, …) is `./build.sh <action>`. No ad-hoc `cargo` invocations in CI.
4. **Test-gated phases** — every phase has a tester described in `docs/MIGRATION.md`. A phase isn't "done" without its test.

## Layered design

```
 ┌─────────────────────────── UI (egui) ───────────────────────────┐
 │  ui-screens · ui-charts · ui-widgets · ui-core (egui_dock)      │
 └───────┬──────────────────────────┬──────────────────────────────┘
         │                          │
 ┌───────▼────────┐         ┌───────▼────────┐
 │    nodegraph   │         │     agents     │  (core, llm, investors, …)
 └───────┬────────┘         └───────┬────────┘
         │                          │
 ┌───────▼──────────────────────────▼───────┐
 │            DataHub (pub/sub bus)          │ ← central data distribution
 └──────┬──────┬──────┬──────┬──────┬────────┘
        │      │      │      │      │
 ┌──────▼┐ ┌───▼───┐ ┌▼────┐ ┌▼───┐ ┌▼──────┐
 │connec-│ │broker-│ │ana- │ │ ml │ │trading│
 │tors   │ │s      │ │lytic│ │    │ │engine │
 └───────┘ └───────┘ └─────┘ └────┘ └───────┘
        │       │       │      │      │
 ┌──────▼───────▼───────▼──────▼──────▼──────┐
 │  http · ws · storage · auth · mcp · core  │ ← infrastructure
 └────────────────────────────────────────────┘
```

## DataHub (port target)

Contract is preserved verbatim from C++ (`~/git/others/FinceptTerminal/fincept-qt/DATAHUB_ARCHITECTURE.md`):

- Topic format: `domain:subdomain:id[:modifier]`
- Producers register refresh logic per topic
- Subscribers auto-clean on `Drop`
- Wildcard patterns: `markets:*`, `markets:us:*`
- Cross-thread publish → subscriber slot invoked on subscriber's task (tokio channel semantics)

Rust impl: `crates/datahub` using `tokio::sync::broadcast` + `dashmap` for topic routing. The 9 Qt-Test cases from `fincept-qt/tests/datahub/test_datahub.cpp` must pass as Rust `#[tokio::test]` cases before Phase 1 ships.

## Binary targets

| OS      | Format   | Recipe                                          |
|---------|----------|-------------------------------------------------|
| Linux   | AppImage | `packaging/linux/AppImageBuilder.yml`           |
| macOS   | DMG      | `packaging/macos/` (cargo-bundle + codesign)    |
| Windows | NSIS     | `packaging/windows/installer.nsi`               |

All three land in Phase 10. Intermediate phases ship plain binaries via `./build.sh ship`.

## Registry coverage gate

CI fails if an entry in `modules.json` with `status=="active"` has no matching crate directory. This prevents the registry and filesystem from drifting. `status=="planned"` entries are exempt — they're the roadmap.
