//! Geopolitical risk scoring. Deterministic rules over 4 inputs normalized to [0,1].

use async_trait::async_trait;
use fincept_agents_core::{Agent, AgentInput, AgentOutput, Error, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeoMetrics {
    pub region: String,
    /// 0..=1, 1 = very high conflict intensity (e.g. ACLED event-count / capita).
    pub conflict_intensity: f64,
    /// 0..=1, 1 = maximum regional sanctions coverage.
    pub sanctions: f64,
    /// 0..=1, 1 = high political stability (WGI-style).
    pub political_stability: f64,
    /// 0..=1, 1 = high trade openness.
    pub trade_openness: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    Low,
    Elevated,
    High,
    Critical,
}

impl RiskLevel {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Elevated => "elevated",
            Self::High => "high",
            Self::Critical => "critical",
        }
    }
}

/// Composite risk 0..=100 (higher = riskier).
#[must_use]
pub fn risk_score(m: &GeoMetrics) -> f64 {
    let conflict = m.conflict_intensity.clamp(0.0, 1.0) * 40.0;
    let sanctions = m.sanctions.clamp(0.0, 1.0) * 25.0;
    let stability_penalty = (1.0 - m.political_stability.clamp(0.0, 1.0)) * 25.0;
    let trade_penalty = (1.0 - m.trade_openness.clamp(0.0, 1.0)) * 10.0;
    (conflict + sanctions + stability_penalty + trade_penalty).clamp(0.0, 100.0)
}

#[must_use]
pub fn risk_level(score: f64) -> RiskLevel {
    match score {
        s if s >= 75.0 => RiskLevel::Critical,
        s if s >= 50.0 => RiskLevel::High,
        s if s >= 25.0 => RiskLevel::Elevated,
        _ => RiskLevel::Low,
    }
}

pub struct GeopoliticalAgent;

#[async_trait]
impl Agent for GeopoliticalAgent {
    fn name(&self) -> &str {
        "geopolitical"
    }
    async fn act(&self, input: &AgentInput) -> Result<AgentOutput> {
        let val = input
            .context
            .get("geo")
            .ok_or_else(|| Error::Failed("missing 'geo' in context".into()))?;
        let m: GeoMetrics = serde_json::from_value(val.clone())
            .map_err(|e| Error::Failed(format!("bad geo metrics: {e}")))?;
        let s = risk_score(&m);
        let lvl = risk_level(s);
        Ok(AgentOutput {
            agent: "geopolitical".into(),
            response: format!("{} risk: {} ({:.1}/100)", m.region, lvl.as_str(), s),
            confidence: 0.8,
            score: Some(s),
            tool_calls: vec![],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn low_risk_stable_open_country() {
        let m = GeoMetrics {
            region: "CH".into(),
            conflict_intensity: 0.0,
            sanctions: 0.0,
            political_stability: 0.95,
            trade_openness: 0.9,
        };
        let s = risk_score(&m);
        assert!(s < 25.0, "score = {s}");
        assert_eq!(risk_level(s), RiskLevel::Low);
    }

    #[test]
    fn critical_risk_war_zone() {
        let m = GeoMetrics {
            region: "X".into(),
            conflict_intensity: 0.95,
            sanctions: 0.9,
            political_stability: 0.1,
            trade_openness: 0.1,
        };
        let s = risk_score(&m);
        assert!(s >= 75.0, "score = {s}");
        assert_eq!(risk_level(s), RiskLevel::Critical);
    }
}
