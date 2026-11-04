//! Macro-economic regime classifier.
//!
//! Score a country's economic health from 4 indicators. Classification is a
//! deterministic 4-way regime (Expansion / Slowdown / Recession / Recovery)
//! driven by thresholds on GDP growth and unemployment change — the standard
//! business-cycle quadrant.

use async_trait::async_trait;
use fincept_agents_core::{Agent, AgentInput, AgentOutput, Error, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MacroMetrics {
    pub country: String,
    /// Year-over-year real GDP growth (e.g. 0.025 = 2.5%).
    pub gdp_growth: f64,
    /// CPI YoY (e.g. 0.03 = 3%).
    pub cpi: f64,
    /// Unemployment rate level (e.g. 0.05 = 5%).
    pub unemployment: f64,
    /// Change in unemployment vs. prior year (signed, e.g. -0.002 = dropping).
    pub unemployment_delta: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Regime {
    Expansion,
    Slowdown,
    Recession,
    Recovery,
}

impl Regime {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Regime::Expansion => "expansion",
            Regime::Slowdown => "slowdown",
            Regime::Recession => "recession",
            Regime::Recovery => "recovery",
        }
    }
}

/// Classify regime from growth + unemployment change.
#[must_use]
pub fn classify(m: &MacroMetrics) -> Regime {
    let growing = m.gdp_growth > 0.01;
    let unemployment_rising = m.unemployment_delta > 0.0;
    match (growing, unemployment_rising) {
        (true, false) => Regime::Expansion,
        (true, true) => Regime::Slowdown,
        (false, true) => Regime::Recession,
        (false, false) => Regime::Recovery,
    }
}

/// 0..=100 health score. Penalizes high inflation and high unemployment,
/// rewards GDP growth.
#[must_use]
pub fn health_score(m: &MacroMetrics) -> f64 {
    // Growth contribution: 0% growth → 50, 5% growth → 100, -5% → 0.
    let growth_s = ((m.gdp_growth * 100.0) * 10.0 + 50.0).clamp(0.0, 100.0);
    // Inflation contribution: 2% ideal, anything above 6% or below 0 penalized.
    let inflation_s = 100.0 - (20.0 * (m.cpi - 0.02).abs() * 100.0 / 10.0).clamp(0.0, 100.0);
    // Unemployment contribution: 4% ideal; each 1pt above reduces by 15.
    let unemployment_s = (100.0 - (m.unemployment * 100.0 - 4.0).max(0.0) * 15.0).clamp(0.0, 100.0);
    // Simple average.
    (growth_s + inflation_s + unemployment_s) / 3.0
}

pub struct EconomicAgent;

#[async_trait]
impl Agent for EconomicAgent {
    fn name(&self) -> &str {
        "economic"
    }

    async fn act(&self, input: &AgentInput) -> Result<AgentOutput> {
        let metrics_val = input
            .context
            .get("macro")
            .ok_or_else(|| Error::Failed("missing 'macro' in context".into()))?;
        let m: MacroMetrics = serde_json::from_value(metrics_val.clone())
            .map_err(|e| Error::Failed(format!("bad macro metrics: {e}")))?;
        let regime = classify(&m);
        let s = health_score(&m);
        Ok(AgentOutput {
            agent: "economic".into(),
            response: format!(
                "{} regime: {} (health {:.1}/100)",
                m.country,
                regime.as_str(),
                s
            ),
            confidence: 0.85,
            score: Some(s),
            tool_calls: vec![],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expansion_growth_positive_unemployment_down() {
        let m = MacroMetrics {
            country: "US".into(),
            gdp_growth: 0.025,
            cpi: 0.03,
            unemployment: 0.04,
            unemployment_delta: -0.002,
        };
        assert_eq!(classify(&m), Regime::Expansion);
    }

    #[test]
    fn recession_when_gdp_negative_unemployment_rising() {
        let m = MacroMetrics {
            country: "X".into(),
            gdp_growth: -0.01,
            cpi: 0.01,
            unemployment: 0.07,
            unemployment_delta: 0.01,
        };
        assert_eq!(classify(&m), Regime::Recession);
    }

    #[test]
    fn health_score_rewards_healthy_economy() {
        let healthy = MacroMetrics {
            country: "X".into(),
            gdp_growth: 0.03,
            cpi: 0.02,
            unemployment: 0.04,
            unemployment_delta: 0.0,
        };
        let sick = MacroMetrics {
            country: "Y".into(),
            gdp_growth: -0.03,
            cpi: 0.08,
            unemployment: 0.10,
            unemployment_delta: 0.02,
        };
        assert!(health_score(&healthy) > health_score(&sick));
    }
}
