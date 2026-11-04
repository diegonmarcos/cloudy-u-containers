//! HTTP client facade. Wraps `reqwest` with sane defaults (timeout, UA)
//! and will grow rate-limit + retry as connectors need it (Phase 2).

use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("reqwest: {0}")]
    Reqwest(#[from] reqwest::Error),
    #[error("build: {0}")]
    Build(String),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone)]
pub struct Config {
    pub user_agent: String,
    pub timeout: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            user_agent: format!("fincept-rs/{}", env!("CARGO_PKG_VERSION")),
            timeout: Duration::from_secs(15),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Client {
    inner: reqwest::Client,
}

impl Client {
    pub fn new(cfg: Config) -> Result<Self> {
        let inner = reqwest::Client::builder()
            .user_agent(cfg.user_agent)
            .timeout(cfg.timeout)
            .build()
            .map_err(|e| Error::Build(e.to_string()))?;
        Ok(Self { inner })
    }

    pub fn reqwest(&self) -> &reqwest::Client {
        &self.inner
    }

    pub async fn get_json<T: serde::de::DeserializeOwned>(&self, url: &str) -> Result<T> {
        let resp = self.inner.get(url).send().await?.error_for_status()?;
        Ok(resp.json().await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn get_json_round_trips() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/quote"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "symbol": "AAPL",
                "price": 187.5
            })))
            .mount(&server)
            .await;

        let client = Client::new(Config::default()).unwrap();
        let v: serde_json::Value = client
            .get_json(&format!("{}/quote", server.uri()))
            .await
            .unwrap();
        assert_eq!(v["symbol"], "AAPL");
        assert_eq!(v["price"], 187.5);
    }
}
