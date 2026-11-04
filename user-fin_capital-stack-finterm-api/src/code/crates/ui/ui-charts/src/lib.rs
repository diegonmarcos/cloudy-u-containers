//! Financial chart primitives built on `egui_plot`.
//!
//! Keeps data transforms (candle colouring, y-range, axis tick formatting)
//! as pure functions so tests can assert them without rendering.

use fincept_ui_core::{egui, Theme};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct OhlcBar {
    pub t: f64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

impl OhlcBar {
    pub fn is_up(&self) -> bool {
        self.close >= self.open
    }

    pub fn color(&self, theme: &Theme) -> egui::Color32 {
        let hex = if self.is_up() {
            &theme.palette.positive
        } else {
            &theme.palette.negative
        };
        Theme::color(hex).unwrap_or(egui::Color32::GRAY)
    }
}

/// Compute (y_min, y_max) across an OHLC series with padding.
pub fn y_range(bars: &[OhlcBar], pad_frac: f64) -> (f64, f64) {
    if bars.is_empty() {
        return (0.0, 1.0);
    }
    let mut lo = f64::INFINITY;
    let mut hi = f64::NEG_INFINITY;
    for b in bars {
        if b.low < lo {
            lo = b.low;
        }
        if b.high > hi {
            hi = b.high;
        }
    }
    let span = (hi - lo).abs();
    let pad = span * pad_frac;
    (lo - pad, hi + pad)
}

pub struct CandlestickChart<'a> {
    pub bars: &'a [OhlcBar],
    pub id: &'a str,
}

impl<'a> CandlestickChart<'a> {
    pub fn render(&self, ui: &mut egui::Ui, theme: &Theme) {
        use egui_plot::{BarChart, Line, Plot, PlotPoints};
        // Body: vertical bar from open→close, coloured by direction.
        let bars_data: Vec<egui_plot::Bar> = self
            .bars
            .iter()
            .map(|b| {
                let center = (b.open + b.close) / 2.0;
                let half = (b.close - b.open).abs() / 2.0;
                egui_plot::Bar::new(b.t, half * 2.0)
                    .base_offset(center - half)
                    .width(0.6)
                    .fill(b.color(theme))
            })
            .collect();
        // Wicks as line segments (min to max).
        let wick: PlotPoints = self
            .bars
            .iter()
            .flat_map(|b| vec![[b.t, b.low], [b.t, b.high], [f64::NAN, f64::NAN]])
            .collect();
        Plot::new(self.id)
            .show_axes([true, true])
            .show(ui, |plot_ui| {
                plot_ui.bar_chart(BarChart::new(bars_data).name("candles"));
                plot_ui.line(Line::new(wick).name("wick"));
            });
    }
}

/// Line chart wrapper — minimalist, used for portfolio equity curves + macro series.
pub struct LineChart<'a> {
    pub points: &'a [(f64, f64)],
    pub id: &'a str,
    pub label: &'a str,
}

impl<'a> LineChart<'a> {
    pub fn render(&self, ui: &mut egui::Ui, _theme: &Theme) {
        use egui_plot::{Line, Plot, PlotPoints};
        let points: PlotPoints = self.points.iter().map(|&(x, y)| [x, y]).collect();
        let label = self.label.to_string();
        Plot::new(self.id).show(ui, |plot_ui| {
            plot_ui.line(Line::new(points).name(label));
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fincept_ui_core::run_headless_ui;

    fn sample() -> Vec<OhlcBar> {
        vec![
            OhlcBar {
                t: 0.0,
                open: 10.0,
                high: 12.0,
                low: 9.5,
                close: 11.5,
                volume: 100.0,
            },
            OhlcBar {
                t: 1.0,
                open: 11.5,
                high: 12.0,
                low: 10.0,
                close: 10.2,
                volume: 150.0,
            },
            OhlcBar {
                t: 2.0,
                open: 10.2,
                high: 13.0,
                low: 10.0,
                close: 12.8,
                volume: 200.0,
            },
        ]
    }

    #[test]
    fn is_up_detects_green_bars() {
        let b = sample();
        assert!(b[0].is_up());
        assert!(!b[1].is_up());
        assert!(b[2].is_up());
    }

    #[test]
    fn y_range_wraps_all_bars() {
        let b = sample();
        let (lo, hi) = y_range(&b, 0.05);
        assert!(lo < 9.5);
        assert!(hi > 13.0);
    }

    #[test]
    fn y_range_empty_is_unit() {
        assert_eq!(y_range(&[], 0.05), (0.0, 1.0));
    }

    #[test]
    fn candlestick_renders_headless() {
        let theme = Theme::default_dark();
        let bars = sample();
        run_headless_ui(|ui| {
            CandlestickChart {
                bars: &bars,
                id: "test-candle",
            }
            .render(ui, &theme);
        });
    }

    #[test]
    fn line_renders_headless() {
        let theme = Theme::default_dark();
        let pts: Vec<(f64, f64)> = (0..10).map(|i| (i as f64, (i as f64) * 2.0)).collect();
        run_headless_ui(|ui| {
            LineChart {
                points: &pts,
                id: "test-line",
                label: "equity",
            }
            .render(ui, &theme);
        });
    }
}
