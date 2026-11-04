//! Phase 8 screens. Each file-scoped struct implements
//! `fincept_ui_core::Screen`. `default_registry()` returns all 10 for use by
//! the app's screen router.
//!
//! Screen content is deliberately minimal in 8a — real data wiring comes in
//! Phase 8b when each screen subscribes to `DataHub` topics. The goal here
//! is: every screen renders without panic, keyboard/theme navigation works,
//! and each screen knows its id/title.

use fincept_ui_core::{egui, Screen, Theme};
use fincept_ui_widgets as w;
use serde::Deserialize;

/// All 51 screens, in display order: 10 Phase-8 custom + 41 Phase-9
/// spec-driven ones loaded from `screen-specs.json` at workspace root.
pub fn default_registry() -> Vec<Box<dyn Screen>> {
    let mut screens: Vec<Box<dyn Screen>> = vec![
        Box::new(DashboardScreen::default()),
        Box::new(MarketsScreen),
        Box::new(WatchlistScreen),
        Box::new(NewsScreen),
        Box::new(EquityResearchScreen),
        Box::new(PortfolioScreen),
        Box::new(TradingScreen),
        Box::new(CryptoScreen),
        Box::new(EconomicsScreen),
        Box::new(SettingsScreen),
    ];
    for spec in load_screen_specs() {
        screens.push(Box::new(SpecScreen::from_spec(spec)));
    }
    screens
}

// ── Spec-driven screens ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ScreenSpec {
    pub id: String,
    pub title: String,
    pub category: String,
    pub summary: String,
}

#[derive(Debug, Deserialize)]
struct ScreenRegistry {
    specs: Vec<ScreenSpec>,
}

/// Load the 41 Phase-9 screen specs from workspace-root `screen-specs.json`.
pub fn load_screen_specs() -> Vec<ScreenSpec> {
    let raw = include_str!("../../../../screen-specs.json");
    let reg: ScreenRegistry = serde_json::from_str(raw).expect("screen-specs.json must be valid");
    reg.specs
}

/// One screen whose id/title/summary come from `screen-specs.json`. Leaks the
/// spec strings (there are only 41, they live for the process) so the
/// `Screen` trait's `&'static str` contract is satisfied without global state.
pub struct SpecScreen {
    id: &'static str,
    title: &'static str,
    category: &'static str,
    summary: &'static str,
}

impl SpecScreen {
    pub fn from_spec(spec: ScreenSpec) -> Self {
        Self {
            id: Box::leak(spec.id.into_boxed_str()),
            title: Box::leak(spec.title.into_boxed_str()),
            category: Box::leak(spec.category.into_boxed_str()),
            summary: Box::leak(spec.summary.into_boxed_str()),
        }
    }

    pub fn category(&self) -> &'static str {
        self.category
    }
}

impl Screen for SpecScreen {
    fn id(&self) -> &'static str {
        self.id
    }
    fn title(&self) -> &'static str {
        self.title
    }
    fn tick(&mut self, ui: &mut egui::Ui, _theme: &Theme) {
        ui.heading(self.title);
        ui.label(format!("category: {}", self.category));
        ui.separator();
        ui.label(self.summary);
        ui.label("(Phase 9b will hydrate from DataHub topics.)");
    }
}

// ── Dashboard ──────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct DashboardScreen {
    ticker: Vec<w::TickerItem>,
}

impl Screen for DashboardScreen {
    fn id(&self) -> &'static str {
        "dashboard"
    }
    fn title(&self) -> &'static str {
        "Dashboard"
    }
    fn tick(&mut self, ui: &mut egui::Ui, theme: &Theme) {
        ui.heading("Dashboard");
        if self.ticker.is_empty() {
            // Placeholder items; Phase 8b replaces with DataHub subscription.
            self.ticker.push(w::TickerItem {
                symbol: "AAPL".into(),
                price: 187.5,
                change_percent: 1.25,
            });
            self.ticker.push(w::TickerItem {
                symbol: "TSLA".into(),
                price: 210.0,
                change_percent: -0.8,
            });
            self.ticker.push(w::TickerItem {
                symbol: "BTC".into(),
                price: 67500.0,
                change_percent: 2.1,
            });
        }
        w::TickerBar {
            items: &self.ticker,
        }
        .render(ui, theme);
        ui.separator();
        ui.label(
            "Widgets: markets, portfolio, news, watchlist panel will hydrate here (Phase 8b).",
        );
    }
}

// ── Markets ────────────────────────────────────────────────────────────────

pub struct MarketsScreen;
impl Screen for MarketsScreen {
    fn id(&self) -> &'static str {
        "markets"
    }
    fn title(&self) -> &'static str {
        "Markets"
    }
    fn tick(&mut self, ui: &mut egui::Ui, theme: &Theme) {
        ui.heading("Markets");
        let cols = [
            w::Column {
                key: "symbol",
                label: "Symbol",
                numeric: false,
            },
            w::Column {
                key: "last",
                label: "Last",
                numeric: true,
            },
            w::Column {
                key: "chg",
                label: "Chg %",
                numeric: true,
            },
        ];
        let rows = vec![
            serde_json::json!({"symbol": "^SPX",  "last": 5234.1, "chg":  0.35}),
            serde_json::json!({"symbol": "^NDX",  "last": 18230.0,"chg":  0.58}),
            serde_json::json!({"symbol": "^VIX",  "last":   13.1, "chg": -2.10}),
        ];
        w::DataTable {
            columns: &cols,
            rows: &rows,
            sort: Some(("symbol", w::SortDir::Asc)),
        }
        .render(ui, theme);
    }
}

// ── Watchlist ──────────────────────────────────────────────────────────────

pub struct WatchlistScreen;
impl Screen for WatchlistScreen {
    fn id(&self) -> &'static str {
        "watchlist"
    }
    fn title(&self) -> &'static str {
        "Watchlist"
    }
    fn tick(&mut self, ui: &mut egui::Ui, theme: &Theme) {
        ui.heading("Watchlist");
        let cols = [
            w::Column {
                key: "symbol",
                label: "Symbol",
                numeric: false,
            },
            w::Column {
                key: "price",
                label: "Price",
                numeric: true,
            },
        ];
        let rows = vec![serde_json::json!({"symbol": "AAPL", "price": 187.5})];
        w::DataTable {
            columns: &cols,
            rows: &rows,
            sort: None,
        }
        .render(ui, theme);
    }
}

// ── News ──────────────────────────────────────────────────────────────────

pub struct NewsScreen;
impl Screen for NewsScreen {
    fn id(&self) -> &'static str {
        "news"
    }
    fn title(&self) -> &'static str {
        "News"
    }
    fn tick(&mut self, ui: &mut egui::Ui, _theme: &Theme) {
        ui.heading("News");
        ui.label("Loading news feed…");
    }
}

// ── Equity Research ───────────────────────────────────────────────────────

pub struct EquityResearchScreen;
impl Screen for EquityResearchScreen {
    fn id(&self) -> &'static str {
        "equity_research"
    }
    fn title(&self) -> &'static str {
        "Equity Research"
    }
    fn tick(&mut self, ui: &mut egui::Ui, _theme: &Theme) {
        ui.heading("Equity Research");
        ui.label("Select a symbol to see valuation + persona scores.");
    }
}

// ── Portfolio ─────────────────────────────────────────────────────────────

pub struct PortfolioScreen;
impl Screen for PortfolioScreen {
    fn id(&self) -> &'static str {
        "portfolio"
    }
    fn title(&self) -> &'static str {
        "Portfolio"
    }
    fn tick(&mut self, ui: &mut egui::Ui, theme: &Theme) {
        ui.heading("Portfolio");
        let equity: Vec<(f64, f64)> = (0..30)
            .map(|i| (i as f64, 100000.0 * (1.0 + 0.003 * i as f64)))
            .collect();
        fincept_ui_charts::LineChart {
            points: &equity,
            id: "portfolio-equity",
            label: "equity",
        }
        .render(ui, theme);
    }
}

// ── Trading ──────────────────────────────────────────────────────────────

pub struct TradingScreen;
impl Screen for TradingScreen {
    fn id(&self) -> &'static str {
        "trading"
    }
    fn title(&self) -> &'static str {
        "Trading"
    }
    fn tick(&mut self, ui: &mut egui::Ui, _theme: &Theme) {
        ui.heading("Trading");
        ui.label("Order entry, open orders, fills — wired to `trading::OrderRouter` in Phase 8b.");
    }
}

// ── Crypto ───────────────────────────────────────────────────────────────

pub struct CryptoScreen;
impl Screen for CryptoScreen {
    fn id(&self) -> &'static str {
        "crypto"
    }
    fn title(&self) -> &'static str {
        "Crypto"
    }
    fn tick(&mut self, ui: &mut egui::Ui, theme: &Theme) {
        ui.heading("Crypto");
        let bars: Vec<fincept_ui_charts::OhlcBar> = (0..20)
            .map(|i| fincept_ui_charts::OhlcBar {
                t: i as f64,
                open: 67000.0 + (i as f64) * 10.0,
                high: 67500.0 + (i as f64) * 10.0,
                low: 66500.0 + (i as f64) * 10.0,
                close: if i % 2 == 0 { 67200.0 } else { 66900.0 } + (i as f64) * 10.0,
                volume: 1000.0 + i as f64,
            })
            .collect();
        fincept_ui_charts::CandlestickChart {
            bars: &bars,
            id: "crypto-candles",
        }
        .render(ui, theme);
    }
}

// ── Economics ────────────────────────────────────────────────────────────

pub struct EconomicsScreen;
impl Screen for EconomicsScreen {
    fn id(&self) -> &'static str {
        "economics"
    }
    fn title(&self) -> &'static str {
        "Economics"
    }
    fn tick(&mut self, ui: &mut egui::Ui, _theme: &Theme) {
        ui.heading("Economics");
        ui.label("FRED / World Bank / OECD series, and regime snapshot.");
    }
}

// ── Settings ─────────────────────────────────────────────────────────────

pub struct SettingsScreen;
impl Screen for SettingsScreen {
    fn id(&self) -> &'static str {
        "settings"
    }
    fn title(&self) -> &'static str {
        "Settings"
    }
    fn tick(&mut self, ui: &mut egui::Ui, _theme: &Theme) {
        ui.heading("Settings");
        ui.label("Theme, API keys, broker credentials.");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fincept_ui_core::{run_headless_ui, ScreenRouter};

    #[test]
    fn registry_has_51_unique_screens() {
        let screens = default_registry();
        assert_eq!(
            screens.len(),
            51,
            "expected 10 custom + 41 spec-driven = 51"
        );
        let mut ids: std::collections::HashSet<&'static str> = std::collections::HashSet::new();
        for s in &screens {
            assert!(ids.insert(s.id()), "duplicate screen id: {}", s.id());
        }
        for id in [
            "dashboard",
            "markets",
            "watchlist",
            "news",
            "equity_research",
            "portfolio",
            "trading",
            "crypto",
            "economics",
            "settings",
        ] {
            assert!(ids.contains(id), "missing custom screen: {id}");
        }
        for id in [
            "markets-heatmap",
            "options-chain",
            "node-editor",
            "ai-chat",
            "maritime-vessels",
            "auth-profile",
        ] {
            assert!(ids.contains(id), "missing spec screen: {id}");
        }
    }

    #[test]
    fn screen_spec_ids_are_unique() {
        let specs = load_screen_specs();
        assert_eq!(specs.len(), 41);
        let mut seen = std::collections::HashSet::new();
        for s in &specs {
            assert!(seen.insert(s.id.clone()), "dup spec id: {}", s.id);
        }
    }

    #[test]
    fn screen_spec_fields_are_non_empty() {
        for s in load_screen_specs() {
            assert!(!s.category.is_empty(), "empty category for {}", s.id);
            assert!(!s.title.is_empty(), "empty title for {}", s.id);
            assert!(!s.summary.is_empty(), "empty summary for {}", s.id);
        }
    }

    #[test]
    fn all_screens_tick_without_panic_dark() {
        let mut router = ScreenRouter::new(default_registry());
        let theme = Theme::default_dark();
        run_headless_ui(|ui| {
            router.tick_all(ui, &theme);
        });
    }

    #[test]
    fn all_screens_tick_without_panic_light() {
        let mut router = ScreenRouter::new(default_registry());
        let theme = Theme::default_light();
        run_headless_ui(|ui| {
            router.tick_all(ui, &theme);
        });
    }

    #[test]
    fn router_switches_between_screens() {
        let mut router = ScreenRouter::new(default_registry());
        assert_eq!(router.active_id(), Some("dashboard"));
        assert!(router.set_active("trading"));
        assert_eq!(router.active_id(), Some("trading"));
        assert!(!router.set_active("unknown_screen"));
    }
}
