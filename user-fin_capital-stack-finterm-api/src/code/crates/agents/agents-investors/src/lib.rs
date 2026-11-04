//! Investor-persona agents. Each persona is a TOML file in
//! `assets/personas/` declaring per-metric weights and threshold anchors.
//! Scoring is deterministic and unit-testable. Phase 6b layers an LLM
//! narrative on top.

use async_trait::async_trait;
use fincept_agents_core::{Agent, AgentInput, AgentOutput, Error, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── Persona config (matches TOML schema) ─────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Persona {
    pub name: String,
    pub style: String,
    pub description: String,
    pub weights: Weights,
    pub thresholds: Thresholds,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Weights {
    pub pe_ratio: f64,
    pub roe: f64,
    pub debt_to_equity: f64,
    pub fcf_yield: f64,
    pub moat_score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Thresholds {
    pub pe_max: f64,
    pub pe_ideal: f64,
    pub roe_min: f64,
    pub roe_ideal: f64,
    pub debt_to_equity_max: f64,
    pub debt_to_equity_ideal: f64,
    pub fcf_yield_min: f64,
    pub fcf_yield_ideal: f64,
}

impl Persona {
    pub fn from_toml(raw: &str) -> Result<Self> {
        toml::from_str(raw).map_err(|e| Error::Failed(format!("bad persona toml: {e}")))
    }

    pub fn weights_sum(&self) -> f64 {
        let w = &self.weights;
        w.pe_ratio + w.roe + w.debt_to_equity + w.fcf_yield + w.moat_score
    }
}

// ── Stock metrics (input to scoring) ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StockMetrics {
    pub symbol: String,
    pub pe_ratio: f64,
    pub roe: f64,
    pub debt_to_equity: f64,
    pub fcf_yield: f64,
    /// Qualitative moat score 0..=1 (upstream supplies — analyst input, tag, LLM, etc.)
    pub moat_score: f64,
}

// ── Scoring ─────────────────────────────────────────────────────────────────

/// Map a metric to [0, 100] by linear interpolation between `bad` and `ideal`.
/// `higher_is_better = true` → `ideal > bad`; otherwise `ideal < bad`.
fn score_linear(value: f64, bad: f64, ideal: f64) -> f64 {
    if (ideal - bad).abs() < 1e-12 {
        return 50.0;
    }
    let raw = if ideal > bad {
        (value - bad) / (ideal - bad)
    } else {
        (bad - value) / (bad - ideal)
    };
    (raw * 100.0).clamp(0.0, 100.0)
}

/// Score a stock against a persona. Returns 0..=100.
#[must_use]
pub fn score(persona: &Persona, m: &StockMetrics) -> f64 {
    let t = &persona.thresholds;
    let pe_s = score_linear(m.pe_ratio, t.pe_max, t.pe_ideal); // lower better
    let roe_s = score_linear(m.roe, t.roe_min, t.roe_ideal); // higher better
    let de_s = score_linear(
        m.debt_to_equity,
        t.debt_to_equity_max,
        t.debt_to_equity_ideal,
    ); // lower
    let fcf_s = score_linear(m.fcf_yield, t.fcf_yield_min, t.fcf_yield_ideal); // higher
    let moat_s = (m.moat_score * 100.0).clamp(0.0, 100.0);

    let w = &persona.weights;
    let sum_w = persona.weights_sum().max(1e-12);
    (pe_s * w.pe_ratio
        + roe_s * w.roe
        + de_s * w.debt_to_equity
        + fcf_s * w.fcf_yield
        + moat_s * w.moat_score)
        / sum_w
}

/// Convert a numeric score to a discrete recommendation.
#[must_use]
pub fn recommend(score: f64) -> &'static str {
    match score {
        s if s >= 75.0 => "strong_buy",
        s if s >= 55.0 => "buy",
        s if s >= 40.0 => "hold",
        s if s >= 20.0 => "reduce",
        _ => "sell",
    }
}

// ── Agent impl ──────────────────────────────────────────────────────────────

pub struct InvestorAgent {
    persona: Persona,
}

impl InvestorAgent {
    pub fn new(persona: Persona) -> Self {
        Self { persona }
    }

    /// Build the 6 canonical personas from bundled TOML.
    pub fn default_roster() -> Result<HashMap<String, Persona>> {
        let files = [
            (
                "buffett",
                include_str!("../../../../assets/personas/buffett.toml"),
            ),
            (
                "graham",
                include_str!("../../../../assets/personas/graham.toml"),
            ),
            (
                "lynch",
                include_str!("../../../../assets/personas/lynch.toml"),
            ),
            (
                "munger",
                include_str!("../../../../assets/personas/munger.toml"),
            ),
            (
                "klarman",
                include_str!("../../../../assets/personas/klarman.toml"),
            ),
            (
                "marks",
                include_str!("../../../../assets/personas/marks.toml"),
            ),
        ];
        let mut out = HashMap::new();
        for (id, raw) in files {
            out.insert(id.to_string(), Persona::from_toml(raw)?);
        }
        Ok(out)
    }
}

#[async_trait]
impl Agent for InvestorAgent {
    fn name(&self) -> &str {
        &self.persona.name
    }

    async fn act(&self, input: &AgentInput) -> Result<AgentOutput> {
        // Expect stock metrics in `context["stock"]`.
        let metrics_val = input
            .context
            .get("stock")
            .ok_or_else(|| Error::Failed("missing 'stock' metrics in input context".into()))?;
        let metrics: StockMetrics = serde_json::from_value(metrics_val.clone())
            .map_err(|e| Error::Failed(format!("bad stock metrics: {e}")))?;

        let s = score(&self.persona, &metrics);
        let rec = recommend(s);
        Ok(AgentOutput {
            agent: self.persona.name.clone(),
            response: format!(
                "{} → {} ({}) — score {:.1}/100, style: {}",
                metrics.symbol, rec, self.persona.name, s, self.persona.style
            ),
            confidence: 0.9,
            score: Some(s),
            tool_calls: vec![],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aapl_quality() -> StockMetrics {
        // High-quality franchise profile: low P/E, high ROE, low debt, good FCF yield.
        StockMetrics {
            symbol: "AAPL".into(),
            pe_ratio: 12.0,
            roe: 0.25,
            debt_to_equity: 0.3,
            fcf_yield: 0.08,
            moat_score: 0.9,
        }
    }

    fn cheap_junk() -> StockMetrics {
        // Over-leveraged trash: high debt, low ROE.
        StockMetrics {
            symbol: "JUNK".into(),
            pe_ratio: 35.0,
            roe: 0.02,
            debt_to_equity: 3.0,
            fcf_yield: 0.0,
            moat_score: 0.1,
        }
    }

    #[test]
    fn all_personas_load_from_toml() {
        let roster = InvestorAgent::default_roster().unwrap();
        assert_eq!(roster.len(), 6);
        for id in ["buffett", "graham", "lynch", "munger", "klarman", "marks"] {
            assert!(roster.contains_key(id), "missing {id}");
        }
    }

    #[test]
    fn persona_weights_sum_to_one() {
        let roster = InvestorAgent::default_roster().unwrap();
        for (id, p) in &roster {
            let sum = p.weights_sum();
            assert!(
                (sum - 1.0).abs() < 1e-6,
                "{id} weights sum to {sum}, expected 1.0"
            );
        }
    }

    #[test]
    fn buffett_likes_quality_hates_junk() {
        let roster = InvestorAgent::default_roster().unwrap();
        let buffett = roster.get("buffett").unwrap();
        let quality = score(buffett, &aapl_quality());
        let junk = score(buffett, &cheap_junk());
        assert!(quality > 70.0, "Buffett score on quality = {quality}");
        assert!(junk < 30.0, "Buffett score on junk = {junk}");
    }

    #[tokio::test]
    async fn agent_act_returns_scored_output() {
        let roster = InvestorAgent::default_roster().unwrap();
        let agent = InvestorAgent::new(roster["buffett"].clone());
        let mut ctx = HashMap::new();
        ctx.insert(
            "stock".into(),
            serde_json::to_value(aapl_quality()).unwrap(),
        );
        let out = agent
            .act(&AgentInput {
                query: "what do you think?".into(),
                context: ctx,
            })
            .await
            .unwrap();
        assert!(out.score.unwrap() > 70.0);
        assert!(out.response.contains("AAPL"));
        assert!(out.response.contains("Buffett"));
    }
}
