//! Shared primitives for every agent crate.
//!
//! - `Agent` trait — the contract every concrete agent implements.
//! - `Memory` trait — HashMap-backed default, vector store impls land Phase 6b.
//! - `AgentInput` / `AgentOutput` — structured payload (no string-only slop).
//! - `Guardrail` — pre/post validators that can reject an output.
//! - `MockAgent` + `InMemoryMemory` — deterministic baselines for testing.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("agent failed: {0}")]
    Failed(String),
    #[error("guardrail rejected output: {0}")]
    Rejected(String),
    #[error("mcp: {0}")]
    Mcp(#[from] fincept_mcp::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

// ── Message shapes ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentInput {
    pub query: String,
    #[serde(default)]
    pub context: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub tool: String,
    pub args: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOutput {
    pub agent: String,
    pub response: String,
    /// 0.0 → no confidence, 1.0 → maximal confidence.
    pub confidence: f64,
    /// Structured score in [0, 100] for downstream orchestration
    /// (e.g. investor personas, hedge-fund aggregator).
    pub score: Option<f64>,
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
}

// ── Agent trait ──────────────────────────────────────────────────────────────

#[async_trait]
pub trait Agent: Send + Sync {
    fn name(&self) -> &str;
    async fn act(&self, input: &AgentInput) -> Result<AgentOutput>;
}

// ── Memory ──────────────────────────────────────────────────────────────────

pub trait Memory: Send + Sync {
    fn put(&self, key: &str, value: serde_json::Value);
    fn get(&self, key: &str) -> Option<serde_json::Value>;
    fn keys(&self) -> Vec<String>;
}

pub struct InMemoryMemory {
    inner: Mutex<HashMap<String, serde_json::Value>>,
}

impl Default for InMemoryMemory {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

impl Memory for InMemoryMemory {
    fn put(&self, key: &str, value: serde_json::Value) {
        self.inner.lock().unwrap().insert(key.to_string(), value);
    }
    fn get(&self, key: &str) -> Option<serde_json::Value> {
        self.inner.lock().unwrap().get(key).cloned()
    }
    fn keys(&self) -> Vec<String> {
        self.inner.lock().unwrap().keys().cloned().collect()
    }
}

// ── Guardrail ───────────────────────────────────────────────────────────────

/// Validators that run on agent outputs. If any guardrail rejects, the
/// output is propagated as `Error::Rejected`.
pub trait Guardrail: Send + Sync {
    fn name(&self) -> &str;
    fn check(&self, output: &AgentOutput) -> Result<()>;
}

/// Reject outputs with confidence below a threshold.
pub struct MinConfidence(pub f64);

impl Guardrail for MinConfidence {
    fn name(&self) -> &str {
        "min-confidence"
    }
    fn check(&self, output: &AgentOutput) -> Result<()> {
        if output.confidence < self.0 {
            return Err(Error::Rejected(format!(
                "confidence {} below threshold {}",
                output.confidence, self.0
            )));
        }
        Ok(())
    }
}

/// Apply every guardrail in order, short-circuit on first rejection.
pub fn apply_guardrails(output: &AgentOutput, guards: &[Box<dyn Guardrail>]) -> Result<()> {
    for g in guards {
        g.check(output)?;
    }
    Ok(())
}

// ── Mock agent for testing ──────────────────────────────────────────────────

pub struct MockAgent {
    pub name: String,
    pub canned: AgentOutput,
}

#[async_trait]
impl Agent for MockAgent {
    fn name(&self) -> &str {
        &self.name
    }
    async fn act(&self, _input: &AgentInput) -> Result<AgentOutput> {
        Ok(self.canned.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_agent_returns_canned() {
        let agent = MockAgent {
            name: "mock".into(),
            canned: AgentOutput {
                agent: "mock".into(),
                response: "hi".into(),
                confidence: 0.9,
                score: Some(80.0),
                tool_calls: vec![],
            },
        };
        let out = agent.act(&AgentInput::default()).await.unwrap();
        assert_eq!(out.response, "hi");
        assert_eq!(out.score, Some(80.0));
    }

    #[test]
    fn in_memory_memory_roundtrip() {
        let m = InMemoryMemory::default();
        m.put("a", serde_json::json!(42));
        assert_eq!(m.get("a"), Some(serde_json::json!(42)));
        assert!(m.keys().contains(&"a".to_string()));
    }

    #[test]
    fn min_confidence_rejects_low() {
        let out = AgentOutput {
            agent: "x".into(),
            response: "".into(),
            confidence: 0.3,
            score: None,
            tool_calls: vec![],
        };
        let g: Box<dyn Guardrail> = Box::new(MinConfidence(0.5));
        let err = g.check(&out).unwrap_err();
        assert!(matches!(err, Error::Rejected(_)));
    }
}
