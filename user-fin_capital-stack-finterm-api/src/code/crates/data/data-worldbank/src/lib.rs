//! World Bank Open Data — country/indicator endpoint.

use async_trait::async_trait;
use fincept_data_core::{Connector, ConnectorError, Result, TopicPattern};
use fincept_http::Client;
use serde::{Deserialize, Serialize};

pub const DEFAULT_BASE_URL: &str = "https://api.worldbank.org";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Row {
    pub year: String,
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Series {
    pub country: String,
    pub indicator: String,
    pub rows: Vec<Row>,
}

#[derive(Debug, Clone)]
pub struct Query {
    pub country: String,
    pub indicator: String,
}

pub struct WorldBankConnector {
    http: Client,
    base_url: String,
}

impl WorldBankConnector {
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
impl Connector for WorldBankConnector {
    type Query = Query;

    fn id(&self) -> &'static str {
        "worldbank"
    }

    fn topic_patterns(&self) -> Vec<TopicPattern> {
        vec![TopicPattern::new("econ:worldbank:*")]
    }

    async fn fetch(&self, q: &Query) -> Result<serde_json::Value> {
        if q.country.is_empty() || q.indicator.is_empty() {
            return Err(ConnectorError::BadQuery(
                "country and indicator required".into(),
            ));
        }
        let url = format!(
            "{}/v2/country/{}/indicator/{}?format=json&per_page=20000",
            self.base_url, q.country, q.indicator
        );
        let raw: serde_json::Value = self.http.get_json(&url).await?;
        // Response is [metadata, [rows...]]
        let rows_json = raw
            .as_array()
            .and_then(|a| a.get(1))
            .and_then(|v| v.as_array())
            .ok_or_else(|| ConnectorError::Vendor("expected [meta,rows] shape".into()))?;
        let rows = rows_json
            .iter()
            .map(|r| Row {
                year: r["date"].as_str().unwrap_or_default().to_string(),
                value: r["value"].as_f64(),
            })
            .collect();
        Ok(serde_json::to_value(Series {
            country: q.country.clone(),
            indicator: q.indicator.clone(),
            rows,
        })?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn fetches_wb_series() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v2/country/US/indicator/NY.GDP.MKTP.CD"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([
                { "page": 1, "pages": 1, "per_page": 20000, "total": 2 },
                [
                    { "indicator": {"id":"NY.GDP.MKTP.CD"}, "country":{"id":"US"}, "date":"2023", "value": 27_000_000_000_000.0 },
                    { "indicator": {"id":"NY.GDP.MKTP.CD"}, "country":{"id":"US"}, "date":"2022", "value": 25_464_475_000_000.0 }
                ]
            ])))
            .mount(&server)
            .await;
        let http = Client::new(Default::default()).unwrap();
        let c = WorldBankConnector::with_base_url(http, server.uri());
        let out = c
            .fetch(&Query {
                country: "US".into(),
                indicator: "NY.GDP.MKTP.CD".into(),
            })
            .await
            .unwrap();
        assert_eq!(out["country"], "US");
        assert_eq!(out["rows"][0]["year"], "2023");
        assert_eq!(out["rows"][1]["value"], 25_464_475_000_000.0);
    }
}
