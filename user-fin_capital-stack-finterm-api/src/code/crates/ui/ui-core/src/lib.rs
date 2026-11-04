//! UI core.
//!
//! - `Theme` — color palette + typography, loaded from `assets/themes/*.json`
//! - `Screen` — every screen implements this; takes a theme + an egui `Ui`
//! - `run_headless_ui` — test helper: runs a closure in a headless egui
//!   context so widget/screen render code paths are exercised in CI without
//!   a GPU. Any panic inside the closure fails the test.

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub use egui;

#[derive(Debug, Error)]
pub enum Error {
    #[error("theme parse: {0}")]
    ThemeParse(#[from] serde_json::Error),
    #[error("invalid color: {0}")]
    InvalidColor(String),
}

pub type Result<T> = std::result::Result<T, Error>;

// ── Theme ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Palette {
    pub background: String,
    pub surface: String,
    pub surface_alt: String,
    pub text: String,
    pub text_muted: String,
    pub accent: String,
    pub positive: String,
    pub negative: String,
    pub warning: String,
    pub grid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FontSpec {
    pub size_small: f32,
    pub size_body: f32,
    pub size_heading: f32,
    pub monospace_size: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Theme {
    pub name: String,
    pub mode: ThemeMode,
    pub palette: Palette,
    pub font: FontSpec,
}

impl Theme {
    pub fn from_json(raw: &str) -> Result<Self> {
        Ok(serde_json::from_str(raw)?)
    }

    /// Convenience: returns the default dark theme bundled at build time.
    pub fn default_dark() -> Self {
        let raw = include_str!("../../../../assets/themes/dark.json");
        Self::from_json(raw).expect("dark.json must be valid")
    }

    /// Convenience: returns the default light theme bundled at build time.
    pub fn default_light() -> Self {
        let raw = include_str!("../../../../assets/themes/light.json");
        Self::from_json(raw).expect("light.json must be valid")
    }

    /// Parse a palette hex string like "#0d1117" or "#rgba" into egui Color32.
    pub fn color(hex: &str) -> Result<egui::Color32> {
        let hex = hex.trim_start_matches('#');
        if hex.len() != 6 && hex.len() != 8 {
            return Err(Error::InvalidColor(hex.into()));
        }
        let parse = |i: usize| {
            u8::from_str_radix(&hex[i..i + 2], 16).map_err(|e| Error::InvalidColor(e.to_string()))
        };
        let r = parse(0)?;
        let g = parse(2)?;
        let b = parse(4)?;
        let a = if hex.len() == 8 { parse(6)? } else { 255 };
        Ok(egui::Color32::from_rgba_unmultiplied(r, g, b, a))
    }
}

// ── Screen trait ────────────────────────────────────────────────────────────

/// Contract every screen implements.
///
/// `tick(ui, theme)` is the egui render call. Keeping the signature this
/// narrow means screens are trivially composable (router calls `tick` on the
/// currently active screen) and unit-testable via `run_headless_ui`.
pub trait Screen: Send + Sync {
    fn id(&self) -> &'static str;
    fn title(&self) -> &'static str;
    fn tick(&mut self, ui: &mut egui::Ui, theme: &Theme);
}

/// Simple in-memory router by screen id.
pub struct ScreenRouter {
    screens: Vec<Box<dyn Screen>>,
    active: usize,
}

impl ScreenRouter {
    pub fn new(screens: Vec<Box<dyn Screen>>) -> Self {
        Self { screens, active: 0 }
    }

    pub fn len(&self) -> usize {
        self.screens.len()
    }
    pub fn is_empty(&self) -> bool {
        self.screens.is_empty()
    }

    pub fn active_id(&self) -> Option<&'static str> {
        self.screens.get(self.active).map(|s| s.id())
    }

    pub fn set_active(&mut self, id: &str) -> bool {
        if let Some(idx) = self.screens.iter().position(|s| s.id() == id) {
            self.active = idx;
            true
        } else {
            false
        }
    }

    pub fn ids(&self) -> Vec<&'static str> {
        self.screens.iter().map(|s| s.id()).collect()
    }

    pub fn tick(&mut self, ui: &mut egui::Ui, theme: &Theme) {
        if let Some(s) = self.screens.get_mut(self.active) {
            s.tick(ui, theme);
        }
    }

    /// Render every registered screen once (used by smoke tests).
    pub fn tick_all(&mut self, ui: &mut egui::Ui, theme: &Theme) {
        for s in self.screens.iter_mut() {
            s.tick(ui, theme);
        }
    }
}

// ── Headless test helper ────────────────────────────────────────────────────

/// Run a closure inside a headless egui context. Any panic inside the
/// closure propagates, failing the test. Zero GPU, zero window — pure CPU
/// egui shape generation.
///
/// `egui::Context::run` requires `FnMut`, so we wrap the one-shot closure
/// in an `Option` and `take()` it the first time round.
pub fn run_headless_ui<F: FnOnce(&mut egui::Ui)>(f: F) {
    let mut slot: Option<F> = Some(f);
    let ctx = egui::Context::default();
    let raw_input = egui::RawInput::default();
    let _ = ctx.run(raw_input, |ctx| {
        egui::CentralPanel::default().show(ctx, |ui| {
            if let Some(cb) = slot.take() {
                cb(ui);
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_dark_theme() {
        let t = Theme::default_dark();
        assert_eq!(t.name, "dark");
        assert_eq!(t.mode, ThemeMode::Dark);
        assert_eq!(t.palette.background, "#0d1117");
    }

    #[test]
    fn parse_light_theme() {
        let t = Theme::default_light();
        assert_eq!(t.name, "light");
        assert_eq!(t.mode, ThemeMode::Light);
    }

    #[test]
    fn color_hex_roundtrip() {
        let c = Theme::color("#58a6ff").unwrap();
        assert_eq!(c.r(), 0x58);
        assert_eq!(c.g(), 0xa6);
        assert_eq!(c.b(), 0xff);
        assert_eq!(c.a(), 0xff);
    }

    #[test]
    fn color_with_alpha() {
        let c = Theme::color("#00000080").unwrap();
        assert_eq!(c.a(), 0x80);
    }

    #[test]
    fn color_invalid() {
        assert!(Theme::color("#abc").is_err());
        assert!(Theme::color("notahex").is_err());
    }

    struct DummyScreen;
    impl Screen for DummyScreen {
        fn id(&self) -> &'static str {
            "dummy"
        }
        fn title(&self) -> &'static str {
            "Dummy"
        }
        fn tick(&mut self, ui: &mut egui::Ui, _theme: &Theme) {
            ui.label("hello");
        }
    }

    #[test]
    fn headless_ui_runs_without_panic() {
        let mut s = DummyScreen;
        let theme = Theme::default_dark();
        run_headless_ui(|ui| s.tick(ui, &theme));
    }

    #[test]
    fn router_dispatches_to_active_screen() {
        let mut router = ScreenRouter::new(vec![Box::new(DummyScreen)]);
        assert_eq!(router.active_id(), Some("dummy"));
        assert_eq!(router.len(), 1);
        assert!(router.set_active("dummy"));
        assert!(!router.set_active("nope"));
    }
}
