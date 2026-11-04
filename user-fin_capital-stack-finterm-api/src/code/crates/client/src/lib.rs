//! Typed client for `fin-api` (the deployed fincept-server). WebSocket subscription helper ships
//! Phase 11b; Phase 11a covers the REST surface so desktop + WASM frontends
//! can compile against a single contract.

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("server returned {status}: {body}")]
    Server { status: u16, body: String },
}

pub type Result<T> = std::result::Result<T, Error>;

// ── DTOs — mirrors fin-api response shapes ────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct Health {
    pub status: String,
    pub version: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Info {
    pub version: String,
    pub personas: usize,
    pub mcp_tools: usize,
    pub hub_topics: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PersonaSummary {
    pub id: String,
    pub name: String,
    pub style: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StockMetrics {
    pub symbol: String,
    pub pe_ratio: f64,
    pub roe: f64,
    pub debt_to_equity: f64,
    pub fcf_yield: f64,
    pub moat_score: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScoreRequest {
    pub stock: StockMetrics,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ScoreResponse {
    pub persona: String,
    pub symbol: String,
    pub score: f64,
    pub recommendation: String,
}

// ── Client ──────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct Client {
    http: reqwest::Client,
    base_url: String,
}

impl Client {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::builder()
                .user_agent(format!("fincept-client/{}", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("reqwest client"),
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T> {
        let resp = self.http.get(self.url(path)).send().await?;
        check(&resp).await?;
        Ok(resp.json().await?)
    }

    async fn post_json<B: Serialize, T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T> {
        let resp = self.http.post(self.url(path)).json(body).send().await?;
        check(&resp).await?;
        Ok(resp.json().await?)
    }

    // ── Endpoints ────────────────────────────────────────────────────────────

    pub async fn health(&self) -> Result<Health> {
        self.get_json("/health").await
    }

    pub async fn info(&self) -> Result<Info> {
        self.get_json("/api/v1/info").await
    }

    pub async fn personas(&self) -> Result<Vec<PersonaSummary>> {
        self.get_json("/api/v1/personas").await
    }

    pub async fn score(&self, persona_id: &str, stock: StockMetrics) -> Result<ScoreResponse> {
        self.post_json(
            &format!("/api/v1/personas/{persona_id}/score"),
            &ScoreRequest { stock },
        )
        .await
    }

    pub async fn peek(&self, topic: &str) -> Result<Option<serde_json::Value>> {
        let resp = self
            .http
            .get(self.url(&format!("/api/v1/topics/{topic}/peek")))
            .send()
            .await?;
        if resp.status().as_u16() == 404 {
            return Ok(None);
        }
        check(&resp).await?;
        Ok(Some(resp.json().await?))
    }

    pub async fn publish(&self, topic: &str, value: serde_json::Value) -> Result<()> {
        let resp = self
            .http
            .post(self.url(&format!("/api/v1/topics/{topic}/publish")))
            .json(&value)
            .send()
            .await?;
        check(&resp).await
    }

    pub async fn mcp_tools(&self) -> Result<Vec<serde_json::Value>> {
        self.get_json("/api/v1/mcp/tools").await
    }
}

async fn check(resp: &reqwest::Response) -> Result<()> {
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    // Body consumption: clone by rebuilding via `text()` — cheap for errors.
    Err(Error::Server {
        status: status.as_u16(),
        body: format!(
            "{} {}",
            status.as_u16(),
            status.canonical_reason().unwrap_or("")
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_joins_cleanly() {
        let c = Client::new("http://example.com/");
        assert_eq!(c.url("/x"), "http://example.com/x");
        let c = Client::new("http://example.com");
        assert_eq!(c.url("/x"), "http://example.com/x");
    }
}
