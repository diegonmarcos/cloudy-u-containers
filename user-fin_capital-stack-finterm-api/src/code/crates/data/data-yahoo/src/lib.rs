//! Yahoo Finance connector. Hits the public `query1.finance.yahoo.com` chart
//! endpoint. No API key.

use async_trait::async_trait;
use fincept_data_core::{Connector, ConnectorError, Result, TopicPattern};
use fincept_http::Client;
use serde::{Deserialize, Serialize};

/// Default base URL. Overridden in tests via `Client::with_base_url`.
pub const DEFAULT_BASE_URL: &str = "https://query1.finance.yahoo.com";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Quote {
    pub symbol: String,
    pub regular_market_price: f64,
    pub currency: String,
}

#[derive(Debug, Clone)]
pub struct Query {
    pub symbol: String,
}

pub struct YahooConnector {
    http: Client,
    base_url: String,
}

impl YahooConnector {
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
impl Connector for YahooConnector {
    type Query = Query;

    fn id(&self) -> &'static str {
        "yahoo"
    }

    fn topic_patterns(&self) -> Vec<TopicPattern> {
        vec![
            TopicPattern::new("market:quote:*"),
            TopicPattern::new("market:history:*"),
        ]
    }

    async fn fetch(&self, q: &Query) -> Result<serde_json::Value> {
        if q.symbol.is_empty() {
            return Err(ConnectorError::BadQuery("empty symbol".into()));
        }
        let url = format!("{}/v8/finance/chart/{}", self.base_url, q.symbol);
        let raw: serde_json::Value = self.http.get_json(&url).await?;
        let meta = raw
            .pointer("/chart/result/0/meta")
            .ok_or_else(|| ConnectorError::Vendor("no chart.result[0].meta in payload".into()))?;
        let quote = Quote {
            symbol: meta["symbol"].as_str().unwrap_or_default().to_string(),
            regular_market_price: meta["regularMarketPrice"].as_f64().unwrap_or(0.0),
            currency: meta["currency"].as_str().unwrap_or_default().to_string(),
        };
        Ok(serde_json::to_value(quote)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn fixture() -> serde_json::Value {
        // Shape matches live Yahoo response (2025-era).
        serde_json::json!({
            "chart": {
                "result": [{
                    "meta": {
                        "symbol": "AAPL",
                        "regularMarketPrice": 187.5,
                        "currency": "USD"
                    }
                }],
                "error": null
            }
        })
    }

    #[tokio::test]
    async fn fetches_quote_and_normalizes() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v8/finance/chart/AAPL"))
            .respond_with(ResponseTemplate::new(200).set_body_json(fixture()))
            .mount(&server)
            .await;

        let http = Client::new(Default::default()).unwrap();
        let connector = YahooConnector::with_base_url(http, server.uri());
        let out = connector
            .fetch(&Query {
                symbol: "AAPL".into(),
            })
            .await
            .unwrap();
        assert_eq!(out["symbol"], "AAPL");
        assert_eq!(out["regular_market_price"], 187.5);
        assert_eq!(out["currency"], "USD");
    }

    #[tokio::test]
    async fn rejects_empty_symbol() {
        let http = Client::new(Default::default()).unwrap();
        let connector = YahooConnector::new(http);
        let err = connector
            .fetch(&Query { symbol: "".into() })
            .await
            .unwrap_err();
        assert!(matches!(err, ConnectorError::BadQuery(_)));
    }
}
