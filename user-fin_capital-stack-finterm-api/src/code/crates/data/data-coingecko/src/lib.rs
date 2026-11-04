//! CoinGecko public API — `/api/v3/simple/price`.

use async_trait::async_trait;
use fincept_data_core::{Connector, ConnectorError, Result, TopicPattern};
use fincept_http::Client;
use serde::{Deserialize, Serialize};

pub const DEFAULT_BASE_URL: &str = "https://api.coingecko.com";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Price {
    pub coin_id: String,
    pub vs_currency: String,
    pub price: f64,
}

#[derive(Debug, Clone)]
pub struct Query {
    pub coin_id: String,
    pub vs_currency: String,
}

pub struct CoingeckoConnector {
    http: Client,
    base_url: String,
}

impl CoingeckoConnector {
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
impl Connector for CoingeckoConnector {
    type Query = Query;
    fn id(&self) -> &'static str {
        "coingecko"
    }
    fn topic_patterns(&self) -> Vec<TopicPattern> {
        vec![TopicPattern::new("crypto:coingecko:*")]
    }
    async fn fetch(&self, q: &Query) -> Result<serde_json::Value> {
        if q.coin_id.is_empty() || q.vs_currency.is_empty() {
            return Err(ConnectorError::BadQuery(
                "coin_id and vs_currency required".into(),
            ));
        }
        let url = format!(
            "{}/api/v3/simple/price?ids={}&vs_currencies={}",
            self.base_url, q.coin_id, q.vs_currency
        );
        let raw: serde_json::Value = self.http.get_json(&url).await?;
        let price = raw
            .pointer(&format!("/{}/{}", q.coin_id, q.vs_currency))
            .and_then(|v| v.as_f64())
            .ok_or_else(|| {
                ConnectorError::Vendor(format!("missing {}.{}", q.coin_id, q.vs_currency))
            })?;
        Ok(serde_json::to_value(Price {
            coin_id: q.coin_id.clone(),
            vs_currency: q.vs_currency.clone(),
            price,
        })?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn fetches_simple_price() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v3/simple/price"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "bitcoin": { "usd": 67520.12 }
            })))
            .mount(&server)
            .await;
        let http = Client::new(Default::default()).unwrap();
        let c = CoingeckoConnector::with_base_url(http, server.uri());
        let out = c
            .fetch(&Query {
                coin_id: "bitcoin".into(),
                vs_currency: "usd".into(),
            })
            .await
            .unwrap();
        assert_eq!(out["coin_id"], "bitcoin");
        assert_eq!(out["price"], 67520.12);
    }
}
