# Migration Tracker

Living log of the FinceptTerminal → Rust port. Updated as each phase lands.

| Phase | Name                          | Status       | Tester                                       |
|------:|-------------------------------|--------------|----------------------------------------------|
| 0     | Scaffolding                   | **done**     | `./build.sh test` passes on empty workspace  |
| 1     | Core (DataHub, storage, http, ws, mcp) | **done** | 9/9 port tests from `fincept-qt/tests/datahub/test_datahub.cpp` pass |
| 2     | Top-10 data connectors        | **done**     | wiremock golden-file per connector (10/10 pass) |
| 3     | Spec-driven connectors (data-generic) | **done** | every spec in connector-specs.json round-trips via wiremock; coverage gate enforces registry ↔ specs |
| 4     | Analytics + QuantLib subset   | **done**     | per-crate `tests/fixtures/parity.json` + `tests/parity.rs` driver |
| 5     | ML / quant lab                | **done**     | per-crate parity fixtures; bandit converges to best arm under optimistic init |
| 6     | MCP server + agents framework | **done**     | persona TOML roundtrip; bullish/bearish scenarios produce opposite hedge-fund decisions |
| 7     | Brokers + trading engine      | **done**     | paper engine market/limit/cancel + aggregated positions; 15/15 broker specs round-trip via wiremock; alpaca wiremock'd |
| 8     | UI shell + first 10 screens   | **done**     | headless egui `Context::run` — all 10 screens tick without panic under both dark + light themes |
| 9     | Remaining 41 screens + node editor | **done**  | 51/51 screens in registry; screen-specs.json loaded and per-spec field invariants tested; node-graph topological sort + cycle detection |
| 10    | Packaging + cutover           | **done**     | migration crate (C++ SQLite → Rust); AppImage/DMG/NSIS recipes; `./build.sh ship` stages 1.3 MB Linux binary; CI release matrix wired on tag push |
| 11    | Backend/frontend split        | **active**   | capital-stack-finterminal-api (Axum REST+WS; package/binary renamed from `fincept-server` 2026-04-26) + fincept-client + ac-fin_capital-stack-finterminal-api cloud wrapper; 180 tests, live server proved |

## Phase 10 acceptance

- [x] `crates/migration` — SQLite→SQLite re-keyer. Rejects DBs below `MIN_SOURCE_VERSION`; maps upstream `watchlists`/`portfolios`/`kv_settings` → Rust `watchlist`/`portfolio_holding`/`setting`; idempotent via `INSERT OR IGNORE`; returns structured `MigrationReport` (4 tests)
- [x] `packaging/packaging.json` — data-driven recipe index (format, recipe file, tool, output path per OS)
- [x] `packaging/linux/AppImageBuilder.yml` + `fincept.desktop` — AppImage recipe
- [x] `packaging/macos/bundle.toml` + `Info.plist.in` — cargo-bundle + Apple plist template
- [x] `packaging/windows/installer.nsi` — NSIS installer script with uninstaller + registry entries
- [x] `build.sh ship` extended — reads `packaging.json`, invokes recipe's tool if on PATH, soft-skips when absent (CI path). **Engine bug fixed**: honours `CARGO_TARGET_DIR` env var instead of hardcoding `target/release/`
- [x] `.github/workflows/ci.yml` — added `release` job matrix (Linux/macOS/Windows), triggered on `v*` tag push; installs packaging tool per OS; uploads `dist/**` artefact
- [x] Ship smoke test: `./build.sh ship` builds `target/release/fincept` (1.3 MB stripped) and stages to `dist/fincept-linux`; binary boots and prints banner
- [x] 167 total tests, lint green, coverage gate green (48 active crates)

Phase 10b (deferred): actual signed installers on tagged releases require CI secrets (Apple Developer cert, Windows code-sign cert) — out of scope for the port itself.

## Phase 9 acceptance

- [x] `screen-specs.json` at workspace root — 41 remaining screens (id/title/category/summary) across markets, portfolio, trading, research, crypto, economics, forex, commodities, derivatives, fixed-income, geo, AI, automation, reports, developer, auth
- [x] `SpecScreen` in ui-screens interprets each JSON spec → implements `Screen` trait (leaks strings once for `&'static str` contract)
- [x] `default_registry()` grows from 10 → **51 screens** (10 custom + 41 spec-driven). Assertions: uniqueness, presence of canonical ids, every spec field non-empty
- [x] All 51 screens tick without panic under dark + light theme (pre-existing `tick_all` tests now cover the expanded set)
- [x] `crates/nodegraph` — Node + Edge + Graph types, `add_node`/`add_edge` with duplicate/unknown-id rejection, **Kahn's topological sort**, cycle detection, transitive ancestors, JSON pretty round-trip (10 tests)
- [x] 163 total tests, lint green, coverage gate green (47 active crates)

Phase 9b (deferred): egui_node_graph2 UI bindings for the visual node editor; `walkers` map widget for maritime/geopolitical screens; full-screen `egui_kittest` snapshot PR gate.

## Phase 8 acceptance

- [x] `ui-core` — `Theme` (JSON-loaded from `assets/themes/*.json`), `Screen` trait, `ScreenRouter`, `run_headless_ui` test helper that runs egui `Context::run` without a GPU (7 tests)
- [x] `ui-widgets` — `TickerBar`, `DataTable` (JSON-pointer rows + sort asc/desc), `LoadingOverlay`. Ascending + descending sort tested on JSON values (6 tests)
- [x] `ui-charts` — `OhlcBar` + `CandlestickChart` + `LineChart` on egui_plot 0.30; `y_range()` padding, `is_up()` direction, candle color from theme (5 tests)
- [x] `ui-screens` — 10 screens (Dashboard, Markets, Watchlist, News, Equity Research, Portfolio, Trading, Crypto, Economics, Settings) all implement `Screen` trait. Each ticks without panic under dark **and** light theme. Router switches active screen by id (3 tests)
- [x] `assets/themes/{dark,light}.json` — palette + font spec; `#RRGGBB` and `#RRGGBBAA` both parsed
- [x] 152 total tests, lint green, coverage gate green (46 active crates)

Phase 8b (deferred): app main replaced by `eframe::run_native` booting the router; each screen wired to DataHub producers + broker router. Snapshot testing via `egui_kittest` once rendered output matters.

## Phase 7 acceptance

- [x] `brokers-core` — `Broker` trait + unified types (OrderRequest, Order, Fill, Position, Balance, OrderSide/Type/Status, TimeInForce)
- [x] `brokers-paper` — real in-memory matching engine: market fill-on-place, limit order resting + sweep on `tick()`, insufficient-funds rejection, cancel, weighted-avg position update (5 tests)
- [x] `brokers-generic` — spec-driven adapter honouring `broker-specs.json` field-map pointers (+ auth header prefix); wiremock round-trip test iterates all 15 broker specs
- [x] `brokers-alpaca` — custom adapter template (APCA-API-KEY headers, Alpaca v2 /orders + /positions + /account); wiremock tests for place_order + balance
- [x] `broker-specs.json` at workspace root — 15 brokers (Zerodha, Angel One, Upstox, Fyers, Dhan, Groww, Kotak, IIFL, 5paisa, AliceBlue, Shoonya, Motilal, IBKR, Tradier, Saxo)
- [x] `trading` crate — OrderRouter (place/cancel by broker id), RiskCheck (max notional + max qty), Aggregator trait producing cross-broker position book (5 tests)
- [x] `build.sh coverage` hardened — reusable `check_spec_consistency()` applied to both `connector-specs.json` and `broker-specs.json` (same 3-way gate: declared ↔ filesystem ↔ specs)
- [x] `modules.json` kind field: 17 brokers (2 custom + 15 generic) all active; `brokers-core` + `trading` added to infrastructure
- [x] 130 total tests, lint green, coverage gate green (42 active crates)

## Phase 6 acceptance

- [x] 6 agent crates:
  - `agents-core` — Agent/Memory/Guardrail traits, AgentInput/Output, MockAgent, MinConfidence guardrail
  - `agents-llm` — Provider trait, ChatRequest/ChatResponse, MockProvider with deterministic token count
  - `agents-investors` — 6 personas loaded from `assets/personas/*.toml` (Buffett/Graham/Lynch/Munger/Klarman/Marks); deterministic score() + recommend(); InvestorAgent impl
  - `agents-economic` — Regime classifier (4-way quadrant: Expansion/Slowdown/Recession/Recovery) + health_score from GDP/CPI/unemployment
  - `agents-geopolitical` — Risk scorer from conflict intensity, sanctions, political stability, trade openness; 4-level classification
  - `agents-hedgefund` — Multi-team orchestrator (Research/Macro/Risk) with weighted aggregation; produces final conviction + recommendation
- [x] `assets/personas/{buffett,graham,lynch,munger,klarman,marks}.toml` — each with weights summing to 1.0 + thresholds (asserted by test)
- [x] `fincept-mcp` extended with 5 built-in tools: market_data, financial_news, economics_data, factor_backtest, symbol_search (tested via `Registry::with_defaults()`)
- [x] Bullish vs. bearish scenario test: same HedgeFundAgent produces conviction ≥55 on quality+expansion+stable vs. conviction <40 on junk+recession+war-zone
- [x] 113 total tests pass, lint green, coverage gate green (37 active crates)

## Phase 5 acceptance

- [x] 4 ML crates:
  - `ml-candle` — OLS (normal eq. + Gauss-Jordan invert), column standardize, train/test split
  - `ml-factor` — Pearson, Spearman (rank avg), IC-IR, factor Sharpe
  - `ml-rl` — Environment/Agent traits, BanditEnv, tabular Q-learning with ε-greedy + optimistic init
  - `ml-hft` — spread, relative spread, order imbalance, VWAP, Kyle's lambda (via OLS from ml-candle)
- [x] Per-crate `tests/fixtures/parity.json` + `tests/parity.rs` driver (same Phase 4 pattern)
- [x] Tester sanity: OLS recovers β = [1,2,3] on synthetic y=1+2x₁+3x₂; bandit Q-learning selects best arm on 2 seeded setups; Kyle's λ recovers synthetic price-impact slope 0.001
- [x] 96 total tests pass, lint green, coverage gate green (31 active crates)

## Phase 4 acceptance

- [x] 7 analytics crates implementing textbook-verified formulas:
  - `analytics-quant` — mean, stddev, percentile (type-7), skewness, kurtosis
  - `analytics-cfa` — NPV, IRR (Newton-Raphson), FV, PV, WACC, DCF (Gordon TV)
  - `analytics-risk` — volatility, Sharpe, Sortino, historical VaR, max drawdown
  - `analytics-portfolio` — equal weights, 2-asset min-variance (closed form), portfolio return/variance
  - `analytics-derivatives` — Black-Scholes call/put (Hull textbook values), CRR binomial tree
  - `analytics-fixedincome` — bond price, Macaulay/modified duration, convexity
  - `analytics-backtest` — equity curve, total return, annualized (CAGR), Calmar
- [x] Each crate carries `tests/fixtures/parity.json` + `tests/parity.rs` driver (one test loop iterates N cases)
- [x] All 77 tests pass with tolerances 1e-6 to 1e-3 per case; textbook benchmarks (Hull, CFA curriculum) pass within 1e-3
- [x] `./build.sh test` green (77 tests), lint green, coverage gate green (27 active crates)

## Phase 3 acceptance

- [x] `crates/data/data-generic` — `GenericConnector` + `ConnectorSpec` types + URL builder + URL-encoder (3 unit tests)
- [x] `connector-specs.json` at workspace root — 25 real-vendor specs, each with inline test fixture (response + pointer assertions)
- [x] `specs_drive_tests.rs` — one data-driven integration test function that loads the JSON, iterates every spec, runs it through wiremock, validates all assertions (3 tests; inner loop covers all 25 specs)
- [x] `build.sh coverage` hardened:
  - Active custom crates must have a directory (unchanged)
  - Active `kind=generic` connectors must have a matching `id` in connector-specs.json
  - Every spec id must have a modules.json connector entry (no orphan specs)
- [x] `modules.json`: `kind` field added to connector entries; 25 generic connectors activated
- [x] 35 total connectors declared (10 custom + 25 generic); 47 tests pass, lint green

## Phase 2 acceptance

- [x] `crates/data/data-core` — `Connector` trait, `RateLimiter` (governor), `retry` helper (4 tests)
- [x] 10 connector crates, each with `Connector` impl + wiremock golden-file test:
  - data-yahoo, data-polygon, data-fred, data-dbnomics, data-worldbank,
    data-imf, data-kraken, data-akshare, data-coingecko, data-alphavantage
- [x] modules.json: all 10 connectors + data-core flipped to `status=active`
- [x] `./build.sh test` green (41 tests), `./build.sh lint` green, coverage gate green (19 active crates)

## Phase 1 acceptance

- [x] `crates/datahub` — full pub/sub + scheduler + policy + RAII subscription + stats
- [x] 9/9 tests from `fincept-qt/tests/datahub/test_datahub.cpp` ported and green
- [x] `crates/eventbus` — broadcast-based cross-module events (2 tests)
- [x] `crates/storage` — sqlx+SQLite opener + cache table (2 tests)
- [x] `crates/http` — reqwest wrapper + wiremock-verified JSON round-trip
- [x] `crates/ws` — tungstenite facade + URL validation
- [x] `crates/auth` — PIN validation + session expiry (3 tests)
- [x] `crates/mcp` — tool registry + spec (2 tests)
- [x] modules.json: 8/8 infrastructure crates flipped to `status=active`
- [x] coverage gate green, `./build.sh test` green, `./build.sh lint` green (26 total tests)

## Phase 0 acceptance

- [x] `~/git/others/fincept-rs/` skeleton created
- [x] `Cargo.toml` workspace + `rust-toolchain.toml` pinned stable
- [x] `build.sh` with build/test/lint/fmt/clean/secrets/ship/coverage/registry actions
- [x] `build.json` + `modules.json` declared
- [x] `app/` binary + `crates/core/` library stubs compile
- [x] `.github/workflows/ci.yml` wired (fmt, clippy, coverage-gate, test matrix)
- [x] `./build.sh test` green locally (2/2 unit tests pass, coverage gate green)
- [x] `./build.sh lint` green locally (fmt + clippy -D warnings)
- [x] `cargo run --bin fincept` boots and logs Phase 0 banner

## Pointers

- Plan: `~/.claude/plans/squishy-toasting-hejlsberg.md`
- Upstream source: `~/git/others/FinceptTerminal/`
- DataHub contract: `~/git/others/FinceptTerminal/fincept-qt/DATAHUB_ARCHITECTURE.md`
