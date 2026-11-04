//! Alpha Vantage — GLOBAL_QUOTE endpoint.

use async_trait::async_trait;
use fincept_data_core::{Connector, ConnectorError, Result, TopicPattern};
use fincept_http::Client;
use serde::{Deserialize, Serialize};

pub const DEFAULT_BASE_URL: &str = "https://www.alphavantage.co";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlobalQuote {
    pub symbol: String,
    pub price: f64,
    pub change: f64,
    pub change_percent: f64,
}

#[derive(Debug, Clone)]
pub struct Query {
    pub symbol: String,
}

pub struct AlphaVantageConnector {
    http: Client,
    base_url: String,
    api_key: String,
}

impl AlphaVantageConnector {
    pub fn new(http: Client, api_key: impl Into<String>) -> Self {
        Self::with_base_url(http, DEFAULT_BASE_URL, api_key)
    }
    pub fn with_base_url(
        http: Client,
        base_url: impl Into<String>,
        api_key: impl Into<String>,
    ) -> Self {
        Self {
            http,
            base_url: base_url.into(),
            api_key: api_key.into(),
        }
    }
}

#[async_trait]
impl Connector for AlphaVantageConnector {
    type Query = Query;
    fn id(&self) -> &'static str {
        "alphavantage"
    }
    fn topic_patterns(&self) -> Vec<TopicPattern> {
        vec![TopicPattern::new("market:quote:*")]
    }
    fn max_requests_per_sec(&self) -> u32 {
        1
    } // free tier: 5/min ≈ 1/12s ≈ min_interval_ms instead
    async fn fetch(&self, q: &Query) -> Result<serde_json::Value> {
        if q.symbol.is_empty() {
            return Err(ConnectorError::BadQuery("empty symbol".into()));
        }
        let url = format!(
            "{}/query?function=GLOBAL_QUOTE&symbol={}&apikey={}",
            self.base_url, q.symbol, self.api_key
        );
        let raw: serde_json::Value = self.http.get_json(&url).await?;
        let body = raw
            .get("Global Quote")
            .ok_or_else(|| ConnectorError::Vendor("no 'Global Quote' key".into()))?;
        let parse =
            |k: &str| -> f64 { body[k].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0) };
        let change_percent = body["10. change percent"]
            .as_str()
            .and_then(|s| s.trim_end_matches('%').parse().ok())
            .unwrap_or(0.0);
        let gq = GlobalQuote {
            symbol: body["01. symbol"].as_str().unwrap_or(&q.symbol).to_string(),
            price: parse("05. price"),
            change: parse("09. change"),
            change_percent,
        };
        Ok(serde_json::to_value(gq)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn fetches_global_quote() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/query"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "Global Quote": {
                    "01. symbol": "AAPL",
                    "05. price": "187.5000",
                    "09. change": "1.2500",
                    "10. change percent": "0.6712%"
                }
            })))
            .mount(&server)
            .await;
        let http = Client::new(Default::default()).unwrap();
        let c = AlphaVantageConnector::with_base_url(http, server.uri(), "demo");
        let out = c
            .fetch(&Query {
                symbol: "AAPL".into(),
            })
            .await
            .unwrap();
        assert_eq!(out["symbol"], "AAPL");
        assert_eq!(out["price"], 187.5);
        assert_eq!(out["change_percent"], 0.6712);
    }
}
