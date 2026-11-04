//! AkShare-equivalent Chinese markets connector. AkShare (Python) wraps many
//! vendor APIs — we port each directly to skip the Python hop. Phase 2
//! covers Eastmoney's `clist` (stock list), mirroring `ak.stock_zh_a_spot_em()`.
//! Phase 3 expands to futures/bonds/funds endpoints.

use async_trait::async_trait;
use fincept_data_core::{Connector, ConnectorError, Result, TopicPattern};
use fincept_http::Client;
use serde::{Deserialize, Serialize};

pub const DEFAULT_BASE_URL: &str = "https://push2.eastmoney.com";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Stock {
    pub code: String,
    pub name: String,
    pub price: f64,
    pub change_pct: f64,
}

#[derive(Debug, Clone, Default)]
pub struct Query {
    /// Market filter; empty = default "all A-share".
    pub market: String,
    pub page_size: u32,
}

pub struct AkShareConnector {
    http: Client,
    base_url: String,
}

impl AkShareConnector {
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
impl Connector for AkShareConnector {
    type Query = Query;
    fn id(&self) -> &'static str {
        "akshare"
    }
    fn topic_patterns(&self) -> Vec<TopicPattern> {
        vec![TopicPattern::new("market:cn:*")]
    }
    async fn fetch(&self, q: &Query) -> Result<serde_json::Value> {
        let market = if q.market.is_empty() {
            "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23"
        } else {
            q.market.as_str()
        };
        let size = if q.page_size == 0 { 10 } else { q.page_size };
        let url = format!(
            "{}/api/qt/clist/get?pn=1&pz={}&fs={}&fields=f12,f14,f2,f3",
            self.base_url, size, market
        );
        let raw: serde_json::Value = self.http.get_json(&url).await?;
        let diff = raw
            .pointer("/data/diff")
            .and_then(|v| v.as_array())
            .ok_or_else(|| ConnectorError::Vendor("missing data.diff".into()))?;
        let stocks: Vec<Stock> = diff
            .iter()
            .map(|d| Stock {
                code: d["f12"].as_str().unwrap_or_default().to_string(),
                name: d["f14"].as_str().unwrap_or_default().to_string(),
                price: d["f2"].as_f64().unwrap_or(0.0),
                change_pct: d["f3"].as_f64().unwrap_or(0.0),
            })
            .collect();
        Ok(serde_json::to_value(stocks)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn fetches_eastmoney_clist() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/qt/clist/get"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "rc": 0,
                "data": {
                    "total": 2,
                    "diff": [
                        { "f12": "600519", "f14": "贵州茅台", "f2": 1680.0, "f3": 0.85 },
                        { "f12": "000001", "f14": "平安银行", "f2": 11.2,   "f3": -0.3 }
                    ]
                }
            })))
            .mount(&server)
            .await;
        let http = Client::new(Default::default()).unwrap();
        let c = AkShareConnector::with_base_url(http, server.uri());
        let out = c
            .fetch(&Query {
                market: "m:0+t:6".into(),
                page_size: 2,
            })
            .await
            .unwrap();
        assert_eq!(out[0]["code"], "600519");
        assert_eq!(out[0]["price"], 1680.0);
        assert_eq!(out[1]["change_pct"], -0.3);
    }
}
