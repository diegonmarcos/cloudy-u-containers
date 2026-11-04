//! Kraken REST — public ticker endpoint. WebSocket tick stream ships Phase 7.

use async_trait::async_trait;
use fincept_data_core::{Connector, ConnectorError, Result, TopicPattern};
use fincept_http::Client;
use serde::{Deserialize, Serialize};

pub const DEFAULT_BASE_URL: &str = "https://api.kraken.com";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ticker {
    pub pair: String,
    pub last: f64,
    pub bid: f64,
    pub ask: f64,
    pub volume_24h: f64,
}

#[derive(Debug, Clone)]
pub struct Query {
    pub pair: String,
}

pub struct KrakenConnector {
    http: Client,
    base_url: String,
}

impl KrakenConnector {
    pub fn new(http: Client) -> Self {
        Self::with_base_url(http, DEFAULT_BASE_URL)
    }
    pub fn with_base_url(http: Client, base_url: impl Into<String>) -> Self {
        Self {
            http,
            base_url: base_url.into(),
        }
    }
}

#[async_trait]
impl Connector for KrakenConnector {
    type Query = Query;
    fn id(&self) -> &'static str {
        "kraken"
    }
    fn topic_patterns(&self) -> Vec<TopicPattern> {
        vec![
            TopicPattern::new("crypto:kraken:*"),
            TopicPattern::new("ws:kraken:*"),
        ]
    }
    async fn fetch(&self, q: &Query) -> Result<serde_json::Value> {
        if q.pair.is_empty() {
            return Err(ConnectorError::BadQuery("empty pair".into()));
        }
        let url = format!("{}/0/public/Ticker?pair={}", self.base_url, q.pair);
        let raw: serde_json::Value = self.http.get_json(&url).await?;
        if let Some(err) = raw["error"].as_array() {
            if !err.is_empty() {
                return Err(ConnectorError::Vendor(format!("kraken error: {err:?}")));
            }
        }
        // Kraken returns result.{PAIR} where PAIR may be re-keyed (XBT↔BTC).
        let result = raw
            .get("result")
            .and_then(|v| v.as_object())
            .ok_or_else(|| ConnectorError::Vendor("no result object".into()))?;
        let (_pair_key, body) = result
            .iter()
            .next()
            .ok_or_else(|| ConnectorError::Vendor("empty result".into()))?;
        let last = body["c"][0]
            .as_str()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| ConnectorError::Vendor("last price parse".into()))?;
        let bid = body["b"][0]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0);
        let ask = body["a"][0]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0);
        let volume_24h = body["v"][1]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0);
        Ok(serde_json::to_value(Ticker {
            pair: q.pair.clone(),
            last,
            bid,
            ask,
            volume_24h,
        })?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn fetches_ticker() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/0/public/Ticker"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "error": [],
                "result": {
                    "XXBTZUSD": {
                        "a": ["67800.10", "1", "1.000"],
                        "b": ["67795.20", "1", "1.000"],
                        "c": ["67797.50", "0.001"],
                        "v": ["100", "2000"]
                    }
                }
            })))
            .mount(&server)
            .await;
        let http = Client::new(Default::default()).unwrap();
        let c = KrakenConnector::with_base_url(http, server.uri());
        let out = c
            .fetch(&Query {
                pair: "XBTUSD".into(),
            })
            .await
            .unwrap();
        assert_eq!(out["pair"], "XBTUSD");
        assert_eq!(out["last"], 67797.5);
        assert_eq!(out["volume_24h"], 2000.0);
    }
}
