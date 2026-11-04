//! MCP — Model Context Protocol. Phase 1 scope: tool registry + JSON schema
//! primitives. Full `rmcp` wiring (stdio transport, streamable HTTP) lands in
//! Phase 6 when agents come online.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("tool not found: {0}")]
    NotFound(String),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("tool failed: {0}")]
    ToolFailed(String),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema describing arguments (draft-07 shape).
    pub input_schema: serde_json::Value,
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn spec(&self) -> ToolSpec;
    async fn call(&self, args: serde_json::Value) -> Result<serde_json::Value>;
}

/// Registry — maps tool name → implementation. One per MCP server instance.
#[derive(Default)]
pub struct Registry {
    tools: BTreeMap<String, Arc<dyn Tool>>,
}

impl Registry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, tool: Arc<dyn Tool>) {
        self.tools.insert(tool.spec().name.clone(), tool);
    }

    pub fn list(&self) -> Vec<ToolSpec> {
        self.tools.values().map(|t| t.spec()).collect()
    }

    pub async fn call(&self, name: &str, args: serde_json::Value) -> Result<serde_json::Value> {
        let tool = self
            .tools
            .get(name)
            .ok_or_else(|| Error::NotFound(name.to_string()))?
            .clone();
        tool.call(args).await
    }

    /// Registry pre-populated with the 5 built-in Fincept tools:
    ///   `market_data`, `financial_news`, `economics_data`,
    ///   `factor_backtest`, `symbol_search`.
    ///
    /// Phase 6a: tools return hermetic mock payloads so agents can be
    /// exercised end-to-end without network. Phase 7 wires each tool to
    /// its real producer (DataHub + connectors).
    pub fn with_defaults() -> Self {
        let mut r = Self::new();
        for t in default_tools() {
            r.register(t);
        }
        r
    }
}

fn default_tools() -> Vec<Arc<dyn Tool>> {
    vec![
        Arc::new(MockJsonTool {
            name: "market_data",
            description: "Fetch OHLCV for a symbol.",
            schema: serde_json::json!({
                "type": "object",
                "properties": { "symbol": {"type": "string"} },
                "required": ["symbol"]
            }),
            response: serde_json::json!({
                "symbol": "AAPL",
                "close": 187.5,
                "volume": 50000000
            }),
        }),
        Arc::new(MockJsonTool {
            name: "financial_news",
            description: "Search financial news articles.",
            schema: serde_json::json!({
                "type": "object",
                "properties": { "query": {"type": "string"}, "limit": {"type": "integer"} },
                "required": ["query"]
            }),
            response: serde_json::json!({
                "count": 1,
                "articles": [{"title": "Markets close higher", "source": "Reuters"}]
            }),
        }),
        Arc::new(MockJsonTool {
            name: "economics_data",
            description: "Fetch macro-economic series values.",
            schema: serde_json::json!({
                "type": "object",
                "properties": { "series_id": {"type": "string"}, "country": {"type": "string"} },
                "required": ["series_id"]
            }),
            response: serde_json::json!({
                "series_id": "GDP",
                "observations": [{"date": "2026-Q1", "value": 27250.5}]
            }),
        }),
        Arc::new(MockJsonTool {
            name: "factor_backtest",
            description: "Run a factor-based backtest and return summary stats.",
            schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "factor": {"type": "string"},
                    "universe": {"type": "string"},
                    "start": {"type": "string"},
                    "end": {"type": "string"}
                },
                "required": ["factor", "universe"]
            }),
            response: serde_json::json!({
                "sharpe": 1.25, "total_return": 0.18, "max_drawdown": -0.12
            }),
        }),
        Arc::new(MockJsonTool {
            name: "symbol_search",
            description: "Resolve a free-text query to tradable symbols.",
            schema: serde_json::json!({
                "type": "object",
                "properties": { "query": {"type": "string"} },
                "required": ["query"]
            }),
            response: serde_json::json!({
                "matches": [{"symbol": "AAPL", "name": "Apple Inc."}]
            }),
        }),
    ]
}

/// Simple Tool impl that returns a fixed JSON payload. Used for the
/// built-in tool set in Phase 6a and in tests.
struct MockJsonTool {
    name: &'static str,
    description: &'static str,
    schema: serde_json::Value,
    response: serde_json::Value,
}

#[async_trait]
impl Tool for MockJsonTool {
    fn spec(&self) -> ToolSpec {
        ToolSpec {
            name: self.name.to_string(),
            description: self.description.to_string(),
            input_schema: self.schema.clone(),
        }
    }
    async fn call(&self, _args: serde_json::Value) -> Result<serde_json::Value> {
        Ok(self.response.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EchoTool;

    #[async_trait]
    impl Tool for EchoTool {
        fn spec(&self) -> ToolSpec {
            ToolSpec {
                name: "echo".into(),
                description: "echoes input".into(),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": { "msg": { "type": "string" } },
                    "required": ["msg"]
                }),
            }
        }
        async fn call(&self, args: serde_json::Value) -> Result<serde_json::Value> {
            Ok(args)
        }
    }

    #[tokio::test]
    async fn register_and_call() {
        let mut reg = Registry::new();
        reg.register(Arc::new(EchoTool));
        assert_eq!(reg.list().len(), 1);
        let out = reg
            .call("echo", serde_json::json!({"msg":"hi"}))
            .await
            .unwrap();
        assert_eq!(out["msg"], "hi");
    }

    #[tokio::test]
    async fn default_registry_exposes_five_tools() {
        let reg = Registry::with_defaults();
        let specs: std::collections::BTreeSet<String> =
            reg.list().into_iter().map(|s| s.name).collect();
        for n in [
            "market_data",
            "financial_news",
            "economics_data",
            "factor_backtest",
            "symbol_search",
        ] {
            assert!(specs.contains(n), "missing built-in tool {n}");
        }
        // Sanity: calling one returns a non-empty payload.
        let out = reg
            .call("symbol_search", serde_json::json!({"query": "apple"}))
            .await
            .unwrap();
        assert!(out.get("matches").is_some());
    }

    #[tokio::test]
    async fn missing_tool_errors() {
        let reg = Registry::new();
        let err = reg.call("nope", serde_json::json!({})).await.unwrap_err();
        assert!(matches!(err, Error::NotFound(_)));
    }
}
