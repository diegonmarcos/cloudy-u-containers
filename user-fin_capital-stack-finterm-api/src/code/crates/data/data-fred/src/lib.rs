//! FRED — Federal Reserve Bank of St. Louis. Series observations endpoint.

use async_trait::async_trait;
use fincept_data_core::{Connector, ConnectorError, Result, TopicPattern};
use fincept_http::Client;
use serde::{Deserialize, Serialize};

pub const DEFAULT_BASE_URL: &str = "https://api.stlouisfed.org";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Observation {
    pub date: String,
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Series {
    pub series_id: String,
    pub observations: Vec<Observation>,
}

#[derive(Debug, Clone)]
pub struct Query {
    pub series_id: String,
}

pub struct FredConnector {
    http: Client,
    base_url: String,
    api_key: String,
}

impl FredConnector {
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
impl Connector for FredConnector {
    type Query = Query;

    fn id(&self) -> &'static str {
        "fred"
    }

    fn topic_patterns(&self) -> Vec<TopicPattern> {
        vec![TopicPattern::new("econ:fred:*")]
    }

    async fn fetch(&self, q: &Query) -> Result<serde_json::Value> {
        if q.series_id.is_empty() {
            return Err(ConnectorError::BadQuery("empty series_id".into()));
        }
        let url = format!(
            "{}/fred/series/observations?series_id={}&api_key={}&file_type=json",
            self.base_url, q.series_id, self.api_key
        );
        let raw: serde_json::Value = self.http.get_json(&url).await?;
        let obs_json = raw
            .get("observations")
            .and_then(|v| v.as_array())
            .ok_or_else(|| ConnectorError::Vendor("missing observations".into()))?;
        let observations: Vec<Observation> = obs_json
            .iter()
            .map(|o| Observation {
                date: o["date"].as_str().unwrap_or_default().to_string(),
                value: o["value"].as_str().and_then(|s| s.parse().ok()),
            })
            .collect();
        Ok(serde_json::to_value(Series {
            series_id: q.series_id.clone(),
            observations,
        })?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn fetches_series_observations() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/fred/series/observations"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "realtime_start": "2026-04-01",
                "observations": [
                    { "date": "2025-Q4", "value": "27000.0" },
                    { "date": "2026-Q1", "value": "27250.5" }
                ]
            })))
            .mount(&server)
            .await;

        let http = Client::new(Default::default()).unwrap();
        let c = FredConnector::with_base_url(http, server.uri(), "k");
        let out = c
            .fetch(&Query {
                series_id: "GDP".into(),
            })
            .await
            .unwrap();
        assert_eq!(out["series_id"], "GDP");
        assert_eq!(out["observations"][0]["date"], "2025-Q4");
        assert_eq!(out["observations"][1]["value"], 27_250.5);
    }
}
