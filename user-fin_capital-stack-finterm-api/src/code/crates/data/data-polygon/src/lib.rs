//! Polygon.io connector — previous-day aggregate endpoint.

use async_trait::async_trait;
use fincept_data_core::{Connector, ConnectorError, Result, TopicPattern};
use fincept_http::Client;
use serde::{Deserialize, Serialize};

pub const DEFAULT_BASE_URL: &str = "https://api.polygon.io";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PrevDayBar {
    pub ticker: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

#[derive(Debug, Clone)]
pub struct Query {
    pub ticker: String,
}

pub struct PolygonConnector {
    http: Client,
    base_url: String,
    api_key: String,
}

impl PolygonConnector {
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
impl Connector for PolygonConnector {
    type Query = Query;

    fn id(&self) -> &'static str {
        "polygon"
    }

    fn topic_patterns(&self) -> Vec<TopicPattern> {
        vec![
            TopicPattern::new("market:quote:*"),
            TopicPattern::new("market:prev:*"),
        ]
    }

    async fn fetch(&self, q: &Query) -> Result<serde_json::Value> {
        if q.ticker.is_empty() {
            return Err(ConnectorError::BadQuery("empty ticker".into()));
        }
        let url = format!(
            "{}/v2/aggs/ticker/{}/prev?apiKey={}",
            self.base_url, q.ticker, self.api_key
        );
        let raw: serde_json::Value = self.http.get_json(&url).await?;
        let r = raw
            .pointer("/results/0")
            .ok_or_else(|| ConnectorError::Vendor("no results[0]".into()))?;
        let bar = PrevDayBar {
            ticker: raw["ticker"].as_str().unwrap_or(&q.ticker).to_string(),
            open: r["o"].as_f64().unwrap_or_default(),
            high: r["h"].as_f64().unwrap_or_default(),
            low: r["l"].as_f64().unwrap_or_default(),
            close: r["c"].as_f64().unwrap_or_default(),
            volume: r["v"].as_f64().unwrap_or_default(),
        };
        Ok(serde_json::to_value(bar)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn fetches_prev_day_bar() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v2/aggs/ticker/AAPL/prev"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "ticker": "AAPL",
                "results": [{
                    "T": "AAPL",
                    "o": 185.0, "h": 188.0, "l": 184.5, "c": 187.5, "v": 12345678
                }]
            })))
            .mount(&server)
            .await;

        let http = Client::new(Default::default()).unwrap();
        let c = PolygonConnector::with_base_url(http, server.uri(), "test-key");
        let out = c
            .fetch(&Query {
                ticker: "AAPL".into(),
            })
            .await
            .unwrap();
        assert_eq!(out["ticker"], "AAPL");
        assert_eq!(out["close"], 187.5);
        assert_eq!(out["volume"], 12_345_678.0);
    }
}
