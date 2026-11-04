//! Medallion-style multi-team hedge fund.
//!
//! Three teams vote on a decision:
//!   - Research: mean score from N investor-persona agents
//!   - Macro: economic regime + health score
//!   - Risk: geopolitical risk (inverted — lower risk = higher contribution)
//!
//! The fund aggregates with configurable weights and returns a final 0..=100
//! conviction plus a regime-tagged recommendation.

use async_trait::async_trait;
use fincept_agents_core::{Agent, AgentInput, AgentOutput, Error, Result};
use fincept_agents_economic as econ;
use fincept_agents_geopolitical as geo;
use fincept_agents_investors as inv;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamWeights {
    pub research: f64,
    pub macro_: f64,
    pub risk: f64,
}

impl Default for TeamWeights {
    fn default() -> Self {
        Self {
            research: 0.55,
            macro_: 0.25,
            risk: 0.20,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HedgeFundInput {
    pub stock: inv::StockMetrics,
    pub macro_: econ::MacroMetrics,
    pub geo: geo::GeoMetrics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HedgeFundDecision {
    pub symbol: String,
    pub conviction: f64,
    pub recommendation: String,
    pub research_score: f64,
    pub macro_score: f64,
    pub risk_score: f64,
    pub regime: String,
}

pub struct HedgeFundAgent {
    personas: Vec<inv::Persona>,
    weights: TeamWeights,
}

impl HedgeFundAgent {
    pub fn new_with_default_roster() -> Result<Self> {
        let roster = inv::InvestorAgent::default_roster()?;
        // Deterministic ordering for reproducible tests.
        let mut personas: Vec<_> = roster.into_iter().collect();
        personas.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(Self {
            personas: personas.into_iter().map(|(_, p)| p).collect(),
            weights: TeamWeights::default(),
        })
    }

    pub fn with_weights(mut self, w: TeamWeights) -> Self {
        self.weights = w;
        self
    }

    pub fn decide(&self, input: &HedgeFundInput) -> HedgeFundDecision {
        // Research team = mean persona score.
        let research: f64 = self
            .personas
            .iter()
            .map(|p| inv::score(p, &input.stock))
            .sum::<f64>()
            / (self.personas.len() as f64).max(1.0);

        // Macro team = economic health score.
        let macro_s = econ::health_score(&input.macro_);
        let regime = econ::classify(&input.macro_).as_str().to_string();

        // Risk team = 100 - geopolitical risk (higher is safer).
        let geo_risk = geo::risk_score(&input.geo);
        let risk_s = 100.0 - geo_risk;

        let w = &self.weights;
        let sum_w = (w.research + w.macro_ + w.risk).max(1e-12);
        let conviction = (research * w.research + macro_s * w.macro_ + risk_s * w.risk) / sum_w;

        HedgeFundDecision {
            symbol: input.stock.symbol.clone(),
            conviction,
            recommendation: inv::recommend(conviction).to_string(),
            research_score: research,
            macro_score: macro_s,
            risk_score: risk_s,
            regime,
        }
    }
}

#[async_trait]
impl Agent for HedgeFundAgent {
    fn name(&self) -> &str {
        "hedgefund"
    }
    async fn act(&self, input: &AgentInput) -> Result<AgentOutput> {
        let payload_val = input
            .context
            .get("fund_input")
            .ok_or_else(|| Error::Failed("missing 'fund_input' in context".into()))?;
        let payload: HedgeFundInput = serde_json::from_value(payload_val.clone())
            .map_err(|e| Error::Failed(format!("bad fund input: {e}")))?;
        let decision = self.decide(&payload);
        Ok(AgentOutput {
            agent: "hedgefund".into(),
            response: format!(
                "{} → {} (conviction {:.1}/100) [regime: {}]",
                decision.symbol, decision.recommendation, decision.conviction, decision.regime
            ),
            confidence: 0.85,
            score: Some(decision.conviction),
            tool_calls: vec![],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_bullish() -> HedgeFundInput {
        HedgeFundInput {
            stock: inv::StockMetrics {
                symbol: "AAPL".into(),
                pe_ratio: 12.0,
                roe: 0.25,
                debt_to_equity: 0.3,
                fcf_yield: 0.08,
                moat_score: 0.9,
            },
            macro_: econ::MacroMetrics {
                country: "US".into(),
                gdp_growth: 0.03,
                cpi: 0.02,
                unemployment: 0.04,
                unemployment_delta: -0.002,
            },
            geo: geo::GeoMetrics {
                region: "US".into(),
                conflict_intensity: 0.0,
                sanctions: 0.0,
                political_stability: 0.9,
                trade_openness: 0.8,
            },
        }
    }

    fn sample_bearish() -> HedgeFundInput {
        HedgeFundInput {
            stock: inv::StockMetrics {
                symbol: "JUNK".into(),
                pe_ratio: 50.0,
                roe: 0.02,
                debt_to_equity: 4.0,
                fcf_yield: 0.0,
                moat_score: 0.05,
            },
            macro_: econ::MacroMetrics {
                country: "X".into(),
                gdp_growth: -0.03,
                cpi: 0.12,
                unemployment: 0.12,
                unemployment_delta: 0.03,
            },
            geo: geo::GeoMetrics {
                region: "X".into(),
                conflict_intensity: 0.9,
                sanctions: 0.9,
                political_stability: 0.1,
                trade_openness: 0.2,
            },
        }
    }

    #[test]
    fn bullish_scenario_recommends_buy() {
        let fund = HedgeFundAgent::new_with_default_roster().unwrap();
        let d = fund.decide(&sample_bullish());
        assert!(
            d.conviction >= 55.0,
            "conviction = {} (research={}, macro={}, risk={})",
            d.conviction,
            d.research_score,
            d.macro_score,
            d.risk_score
        );
        assert!(matches!(d.recommendation.as_str(), "buy" | "strong_buy"));
    }

    #[test]
    fn bearish_scenario_recommends_sell() {
        let fund = HedgeFundAgent::new_with_default_roster().unwrap();
        let d = fund.decide(&sample_bearish());
        assert!(
            d.conviction < 40.0,
            "conviction = {} (research={}, macro={}, risk={})",
            d.conviction,
            d.research_score,
            d.macro_score,
            d.risk_score
        );
        assert!(matches!(d.recommendation.as_str(), "reduce" | "sell"));
    }

    #[tokio::test]
    async fn agent_trait_roundtrip() {
        let fund = HedgeFundAgent::new_with_default_roster().unwrap();
        let mut ctx = std::collections::HashMap::new();
        ctx.insert(
            "fund_input".into(),
            serde_json::to_value(sample_bullish()).unwrap(),
        );
        let out = fund
            .act(&AgentInput {
                query: "".into(),
                context: ctx,
            })
            .await
            .unwrap();
        assert!(out.score.unwrap() >= 55.0);
    }
}
