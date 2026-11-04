//! IMF DataMapper connector (`datamapper/api/v1`).

use async_trait::async_trait;
use fincept_data_core::{Connector, ConnectorError, Result, TopicPattern};
use fincept_http::Client;
use serde::{Deserialize, Serialize};

pub const DEFAULT_BASE_URL: &str = "https://www.imf.org/external/datamapper/api/v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Point {
    pub year: String,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Series {
    pub indicator: String,
    pub country: String,
    pub points: Vec<Point>,
}

#[derive(Debug, Clone)]
pub struct Query {
    pub indicator: String,
    pub country: String,
}

pub struct ImfConnector {
    http: Client,
    base_url: String,
}

impl ImfConnector {
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
impl Connector for ImfConnector {
    type Query = Query;
    fn id(&self) -> &'static str {
        "imf"
    }
    fn topic_patterns(&self) -> Vec<TopicPattern> {
        vec![TopicPattern::new("econ:imf:*")]
    }
    async fn fetch(&self, q: &Query) -> Result<serde_json::Value> {
        if q.indicator.is_empty() || q.country.is_empty() {
            return Err(ConnectorError::BadQuery(
                "indicator and country required".into(),
            ));
        }
        let url = format!("{}/{}/{}", self.base_url, q.indicator, q.country);
        let raw: serde_json::Value = self.http.get_json(&url).await?;
        // Shape: { values: { NGDP_RPCH: { USA: { "2024": 2.8, ... } } } }
        let years = raw
            .pointer(&format!("/values/{}/{}", q.indicator, q.country))
            .and_then(|v| v.as_object())
            .ok_or_else(|| ConnectorError::Vendor("no values.<ind>.<cc>".into()))?;
        let mut points: Vec<Point> = years
            .iter()
            .filter_map(|(y, v)| {
                v.as_f64().map(|val| Point {
                    year: y.clone(),
                    value: val,
                })
            })
            .collect();
        points.sort_by(|a, b| a.year.cmp(&b.year));
        Ok(serde_json::to_value(Series {
            indicator: q.indicator.clone(),
            country: q.country.clone(),
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
    async fn fetches_imf_series() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/NGDP_RPCH/USA"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "values": { "NGDP_RPCH": { "USA": {
                    "2022": 2.1, "2023": 2.5, "2024": 2.8
                }}}
            })))
            .mount(&server)
            .await;
        let http = Client::new(Default::default()).unwrap();
        let c = ImfConnector::with_base_url(http, server.uri());
        let out = c
            .fetch(&Query {
                indicator: "NGDP_RPCH".into(),
                country: "USA".into(),
            })
            .await
            .unwrap();
        assert_eq!(out["country"], "USA");
        assert_eq!(out["points"][0]["year"], "2022");
        assert_eq!(out["points"][2]["value"], 2.8);
    }
}
