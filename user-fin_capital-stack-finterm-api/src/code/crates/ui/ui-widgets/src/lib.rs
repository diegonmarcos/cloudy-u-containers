//! Reusable widgets.
//!
//! Each widget is a small `struct` holding data + `fn render(&self, ui, theme)`.
//! Keeps rendering separable from data construction — tests fill the data,
//! render, and assert no panics (see ui-core's `run_headless_ui`).

use fincept_ui_core::{egui, Theme};
use serde::{Deserialize, Serialize};

// ── Ticker ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TickerItem {
    pub symbol: String,
    pub price: f64,
    pub change_percent: f64,
}

impl TickerItem {
    pub fn color(&self, theme: &Theme) -> egui::Color32 {
        let hex = if self.change_percent >= 0.0 {
            &theme.palette.positive
        } else {
            &theme.palette.negative
        };
        Theme::color(hex).unwrap_or(egui::Color32::GRAY)
    }

    pub fn render(&self, ui: &mut egui::Ui, theme: &Theme) {
        ui.horizontal(|ui| {
            ui.monospace(&self.symbol);
            ui.label(format!("{:.2}", self.price));
            ui.colored_label(self.color(theme), format!("{:+.2}%", self.change_percent));
        });
    }
}

/// Multi-item ticker bar — left-to-right scrolling strip.
pub struct TickerBar<'a> {
    pub items: &'a [TickerItem],
}

impl<'a> TickerBar<'a> {
    pub fn render(&self, ui: &mut egui::Ui, theme: &Theme) {
        ui.horizontal(|ui| {
            for item in self.items {
                item.render(ui, theme);
                ui.separator();
            }
        });
    }
}

// ── Data table ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Column {
    pub key: &'static str,
    pub label: &'static str,
    pub numeric: bool,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub enum SortDir {
    #[default]
    Asc,
    Desc,
}

pub struct DataTable<'a> {
    pub columns: &'a [Column],
    /// Rows as JSON values; caller provides data-shape matching column keys.
    pub rows: &'a [serde_json::Value],
    pub sort: Option<(&'static str, SortDir)>,
}

impl<'a> DataTable<'a> {
    /// Return indices into `rows` in the order they should be rendered.
    pub fn sorted_indices(&self) -> Vec<usize> {
        let mut idx: Vec<usize> = (0..self.rows.len()).collect();
        if let Some((key, dir)) = self.sort {
            idx.sort_by(|&a, &b| {
                let va = &self.rows[a][key];
                let vb = &self.rows[b][key];
                let ord = cmp_json(va, vb);
                if matches!(dir, SortDir::Desc) {
                    ord.reverse()
                } else {
                    ord
                }
            });
        }
        idx
    }

    pub fn render(&self, ui: &mut egui::Ui, _theme: &Theme) {
        egui::Grid::new("data_table").striped(true).show(ui, |ui| {
            for c in self.columns {
                ui.strong(c.label);
            }
            ui.end_row();
            for i in self.sorted_indices() {
                let row = &self.rows[i];
                for c in self.columns {
                    let cell = &row[c.key];
                    if let Some(s) = cell.as_str() {
                        ui.label(s);
                    } else if let Some(n) = cell.as_f64() {
                        if c.numeric {
                            ui.monospace(format!("{n:.4}"));
                        } else {
                            ui.label(format!("{n}"));
                        }
                    } else {
                        ui.label(cell.to_string());
                    }
                }
                ui.end_row();
            }
        });
    }
}

fn cmp_json(a: &serde_json::Value, b: &serde_json::Value) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => x.partial_cmp(&y).unwrap_or(Ordering::Equal),
        _ => {
            let sa = a.as_str().unwrap_or("");
            let sb = b.as_str().unwrap_or("");
            sa.cmp(sb)
        }
    }
}

// ── Loading overlay ─────────────────────────────────────────────────────────

pub struct LoadingOverlay {
    pub message: String,
}

impl LoadingOverlay {
    pub fn render(&self, ui: &mut egui::Ui, _theme: &Theme) {
        ui.vertical_centered(|ui| {
            ui.spinner();
            ui.label(&self.message);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fincept_ui_core::run_headless_ui;

    #[test]
    fn ticker_item_color_negative() {
        let t = Theme::default_dark();
        let up = TickerItem {
            symbol: "AAPL".into(),
            price: 100.0,
            change_percent: 1.5,
        };
        let down = TickerItem {
            symbol: "AAPL".into(),
            price: 100.0,
            change_percent: -1.5,
        };
        assert_ne!(up.color(&t), down.color(&t));
    }

    #[test]
    fn data_table_sorts_ascending() {
        let cols = [Column {
            key: "v",
            label: "v",
            numeric: true,
        }];
        let rows = vec![
            serde_json::json!({"v": 3}),
            serde_json::json!({"v": 1}),
            serde_json::json!({"v": 2}),
        ];
        let t = DataTable {
            columns: &cols,
            rows: &rows,
            sort: Some(("v", SortDir::Asc)),
        };
        assert_eq!(t.sorted_indices(), vec![1, 2, 0]);
    }

    #[test]
    fn data_table_sorts_descending() {
        let cols = [Column {
            key: "v",
            label: "v",
            numeric: true,
        }];
        let rows = vec![
            serde_json::json!({"v": 3}),
            serde_json::json!({"v": 1}),
            serde_json::json!({"v": 2}),
        ];
        let t = DataTable {
            columns: &cols,
            rows: &rows,
            sort: Some(("v", SortDir::Desc)),
        };
        assert_eq!(t.sorted_indices(), vec![0, 2, 1]);
    }

    #[test]
    fn ticker_renders_headless() {
        let t = Theme::default_dark();
        let items = vec![
            TickerItem {
                symbol: "AAPL".into(),
                price: 187.5,
                change_percent: 1.25,
            },
            TickerItem {
                symbol: "TSLA".into(),
                price: 210.0,
                change_percent: -0.8,
            },
        ];
        run_headless_ui(|ui| {
            TickerBar { items: &items }.render(ui, &t);
        });
    }

    #[test]
    fn loading_overlay_renders_headless() {
        let t = Theme::default_dark();
        let ov = LoadingOverlay {
            message: "loading".into(),
        };
        run_headless_ui(|ui| ov.render(ui, &t));
    }

    #[test]
    fn data_table_renders_headless() {
        let t = Theme::default_dark();
        let cols = [
            Column {
                key: "symbol",
                label: "Symbol",
                numeric: false,
            },
            Column {
                key: "price",
                label: "Price",
                numeric: true,
            },
        ];
        let rows = vec![
            serde_json::json!({"symbol": "AAPL", "price": 187.5}),
            serde_json::json!({"symbol": "TSLA", "price": 210.0}),
        ];
        run_headless_ui(|ui| {
            DataTable {
                columns: &cols,
                rows: &rows,
                sort: Some(("price", SortDir::Asc)),
            }
            .render(ui, &t);
        });
    }
}
