//! DBnomics — aggregator of 80+ public economic data providers.

use async_trait::async_trait;
use fincept_data_core::{Connector, ConnectorError, Result, TopicPattern};
use fincept_http::Client;
use serde::{Deserialize, Serialize};

pub const DEFAULT_BASE_URL: &str = "https://api.db.nomics.world";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Point {
    pub period: String,
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Series {
    pub series_id: String,
    pub name: Option<String>,
    pub points: Vec<Point>,
}

#[derive(Debug, Clone)]
pub struct Query {
    /// Full DBnomics id, e.g. `IMF/IFS/USA.PCPI_IX.Q`
    pub series_id: String,
}

pub struct DbnomicsConnector {
    http: Client,
    base_url: String,
}

impl DbnomicsConnector {
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
impl Connector for DbnomicsConnector {
    type Query = Query;

    fn id(&self) -> &'static str {
        "dbnomics"
    }

    fn topic_patterns(&self) -> Vec<TopicPattern> {
        vec![TopicPattern::new("econ:dbnomics:*")]
    }

    async fn fetch(&self, q: &Query) -> Result<serde_json::Value> {
        if q.series_id.is_empty() {
            return Err(ConnectorError::BadQuery("empty series_id".into()));
        }
        let url = format!(
            "{}/v22/series?series_ids={}&observations=1",
            self.base_url, q.series_id
        );
        let raw: serde_json::Value = self.http.get_json(&url).await?;
        let doc = raw
            .pointer("/series/docs/0")
            .ok_or_else(|| ConnectorError::Vendor("no series.docs[0]".into()))?;
        let periods = doc["period"].as_array().cloned().unwrap_or_default();
        let values = doc["value"].as_array().cloned().unwrap_or_default();
        let points = periods
            .into_iter()
            .zip(values)
            .map(|(p, v)| Point {
                period: p.as_str().unwrap_or_default().to_string(),
                value: v.as_f64(),
            })
            .collect();
        Ok(serde_json::to_value(Series {
            series_id: q.series_id.clone(),
            name: doc["series_name"].as_str().map(str::to_string),
            points,
        })?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn fetches_dbnomics_series() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v22/series"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "series": {
                    "docs": [{
                        "series_id": "IMF/IFS/USA.PCPI_IX.Q",
                        "series_name": "USA CPI Quarterly",
                        "period": ["2024-Q1", "2024-Q2"],
                        "value": [310.1, 312.5]
                    }]
                }
            })))
            .mount(&server)
            .await;
        let http = Client::new(Default::default()).unwrap();
        let c = DbnomicsConnector::with_base_url(http, server.uri());
        let out = c
            .fetch(&Query {
                series_id: "IMF/IFS/USA.PCPI_IX.Q".into(),
            })
            .await
            .unwrap();
        assert_eq!(out["name"], "USA CPI Quarterly");
        assert_eq!(out["points"][0]["period"], "2024-Q1");
        assert_eq!(out["points"][1]["value"], 312.5);
    }
}
