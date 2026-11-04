//! Alpaca Markets broker adapter.
//!
//! This is the canonical *custom* broker template. Most REST brokers fit
//! `brokers-generic`; Alpaca fits that shape too, but we keep a hand-rolled
//! adapter to demonstrate the custom pattern for brokers whose auth dances
//! or signed payloads can't be captured by a spec.

use async_trait::async_trait;
use chrono::Utc;
use fincept_brokers_core::{
    Balance, Broker, Error, Order, OrderRequest, OrderSide, OrderStatus, OrderType, Position,
    Result,
};
use fincept_http::Client;

pub const DEFAULT_PAPER_BASE_URL: &str = "https://paper-api.alpaca.markets";

pub struct AlpacaBroker {
    http: Client,
    base_url: String,
    api_key: String,
    api_secret: String,
}

impl AlpacaBroker {
    pub fn new_paper(
        http: Client,
        api_key: impl Into<String>,
        api_secret: impl Into<String>,
    ) -> Self {
        Self::with_base_url(http, DEFAULT_PAPER_BASE_URL, api_key, api_secret)
    }

    pub fn with_base_url(
        http: Client,
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        api_secret: impl Into<String>,
    ) -> Self {
        Self {
            http,
            base_url: base_url.into(),
            api_key: api_key.into(),
            api_secret: api_secret.into(),
        }
    }

    fn auth_headers(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        req.header("APCA-API-KEY-ID", &self.api_key)
            .header("APCA-API-SECRET-KEY", &self.api_secret)
    }
}

fn map_side(s: OrderSide) -> &'static str {
    match s {
        OrderSide::Buy => "buy",
        OrderSide::Sell => "sell",
    }
}

fn map_type(t: OrderType) -> &'static str {
    match t {
        OrderType::Market => "market",
        OrderType::Limit => "limit",
        OrderType::Stop => "stop",
        OrderType::StopLimit => "stop_limit",
    }
}

fn map_status(s: &str) -> OrderStatus {
    match s {
        "filled" | "done_for_day" => OrderStatus::Filled,
        "partially_filled" => OrderStatus::PartiallyFilled,
        "canceled" | "expired" => OrderStatus::Cancelled,
        "rejected" => OrderStatus::Rejected,
        _ => OrderStatus::Pending,
    }
}

#[async_trait]
impl Broker for AlpacaBroker {
    fn id(&self) -> &str {
        "alpaca"
    }

    async fn connect(&self) -> Result<()> {
        Ok(())
    }

    async fn place_order(&self, req: OrderRequest) -> Result<Order> {
        let url = format!("{}/v2/orders", self.base_url);
        let body = serde_json::json!({
            "symbol": req.symbol,
            "qty": req.quantity,
            "side": map_side(req.side),
            "type": map_type(req.order_type),
            "time_in_force": match req.time_in_force {
                fincept_brokers_core::TimeInForce::Day => "day",
                fincept_brokers_core::TimeInForce::Gtc => "gtc",
                fincept_brokers_core::TimeInForce::Ioc => "ioc",
                fincept_brokers_core::TimeInForce::Fok => "fok",
            },
            "limit_price": req.limit_price,
            "stop_price": req.stop_price,
            "client_order_id": req.client_order_id,
        });
        let resp = self
            .auth_headers(self.http.reqwest().post(&url).json(&body))
            .send()
            .await
            .map_err(|e| Error::Vendor(e.to_string()))?
            .error_for_status()
            .map_err(|e| Error::Vendor(e.to_string()))?;
        let raw: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| Error::Vendor(e.to_string()))?;
        let now = Utc::now();
        Ok(Order {
            id: raw["id"].as_str().unwrap_or_default().to_string(),
            client_order_id: raw["client_order_id"].as_str().map(str::to_string),
            symbol: raw["symbol"].as_str().unwrap_or(&req.symbol).to_string(),
            side: req.side,
            order_type: req.order_type,
            quantity: raw["qty"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or(req.quantity),
            filled_quantity: raw["filled_qty"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0),
            avg_fill_price: raw["filled_avg_price"]
                .as_str()
                .and_then(|s| s.parse().ok()),
            limit_price: req.limit_price,
            stop_price: req.stop_price,
            status: map_status(raw["status"].as_str().unwrap_or("new")),
            created_at: now,
            updated_at: now,
        })
    }

    async fn cancel_order(&self, order_id: &str) -> Result<()> {
        let url = format!("{}/v2/orders/{order_id}", self.base_url);
        self.auth_headers(self.http.reqwest().delete(&url))
            .send()
            .await
            .map_err(|e| Error::Vendor(e.to_string()))?
            .error_for_status()
            .map_err(|e| Error::Vendor(e.to_string()))?;
        Ok(())
    }

    async fn get_order(&self, order_id: &str) -> Result<Order> {
        let url = format!("{}/v2/orders/{order_id}", self.base_url);
        let resp = self
            .auth_headers(self.http.reqwest().get(&url))
            .send()
            .await
            .map_err(|e| Error::Vendor(e.to_string()))?
            .error_for_status()
            .map_err(|e| Error::Vendor(e.to_string()))?;
        let raw: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| Error::Vendor(e.to_string()))?;
        let now = Utc::now();
        Ok(Order {
            id: raw["id"].as_str().unwrap_or(order_id).to_string(),
            client_order_id: raw["client_order_id"].as_str().map(str::to_string),
            symbol: raw["symbol"].as_str().unwrap_or_default().to_string(),
            side: if raw["side"] == "buy" {
                OrderSide::Buy
            } else {
                OrderSide::Sell
            },
            order_type: match raw["type"].as_str().unwrap_or("market") {
                "limit" => OrderType::Limit,
                "stop" => OrderType::Stop,
                "stop_limit" => OrderType::StopLimit,
                _ => OrderType::Market,
            },
            quantity: raw["qty"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0),
            filled_quantity: raw["filled_qty"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0),
            avg_fill_price: raw["filled_avg_price"]
                .as_str()
                .and_then(|s| s.parse().ok()),
            limit_price: raw["limit_price"].as_str().and_then(|s| s.parse().ok()),
            stop_price: raw["stop_price"].as_str().and_then(|s| s.parse().ok()),
            status: map_status(raw["status"].as_str().unwrap_or("new")),
            created_at: now,
            updated_at: now,
        })
    }

    async fn list_orders(&self) -> Result<Vec<Order>> {
        // Phase 7b: iterate and map. Stubbed empty for now.
        Ok(vec![])
    }

    async fn positions(&self) -> Result<Vec<Position>> {
        let url = format!("{}/v2/positions", self.base_url);
        let resp = self
            .auth_headers(self.http.reqwest().get(&url))
            .send()
            .await
            .map_err(|e| Error::Vendor(e.to_string()))?
            .error_for_status()
            .map_err(|e| Error::Vendor(e.to_string()))?;
        let arr: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| Error::Vendor(e.to_string()))?;
        Ok(arr
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .map(|p| Position {
                symbol: p["symbol"].as_str().unwrap_or("").to_string(),
                quantity: p["qty"]
                    .as_str()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0.0),
                avg_entry_price: p["avg_entry_price"]
                    .as_str()
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0.0),
                current_price: p["current_price"].as_str().and_then(|s| s.parse().ok()),
                unrealized_pnl: p["unrealized_pl"].as_str().and_then(|s| s.parse().ok()),
            })
            .collect())
    }

    async fn balance(&self) -> Result<Balance> {
        let url = format!("{}/v2/account", self.base_url);
        let resp = self
            .auth_headers(self.http.reqwest().get(&url))
            .send()
            .await
            .map_err(|e| Error::Vendor(e.to_string()))?
            .error_for_status()
            .map_err(|e| Error::Vendor(e.to_string()))?;
        let raw: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| Error::Vendor(e.to_string()))?;
        Ok(Balance {
            cash: raw["cash"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0),
            equity: raw["equity"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0),
            currency: raw["currency"].as_str().unwrap_or("USD").to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fincept_brokers_core::TimeInForce;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[tokio::test]
    async fn place_order_parses_alpaca_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v2/orders"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": "alpaca-order-1",
                "client_order_id": "cli-1",
                "symbol": "AAPL",
                "qty": "10",
                "filled_qty": "0",
                "filled_avg_price": null,
                "status": "new",
                "side": "buy",
                "type": "market"
            })))
            .mount(&server)
            .await;

        let http = Client::new(Default::default()).unwrap();
        let b = AlpacaBroker::with_base_url(http, server.uri(), "k", "s");
        let ord = b
            .place_order(OrderRequest {
                symbol: "AAPL".into(),
                side: OrderSide::Buy,
                order_type: OrderType::Market,
                quantity: 10.0,
                limit_price: None,
                stop_price: None,
                time_in_force: TimeInForce::Day,
                client_order_id: Some("cli-1".into()),
            })
            .await
            .unwrap();
        assert_eq!(ord.id, "alpaca-order-1");
        assert_eq!(ord.quantity, 10.0);
        assert_eq!(ord.status, OrderStatus::Pending);
    }

    #[tokio::test]
    async fn balance_parses_alpaca_account() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v2/account"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "cash": "50000.5", "equity": "62000.0", "currency": "USD"
            })))
            .mount(&server)
            .await;
        let http = Client::new(Default::default()).unwrap();
        let b = AlpacaBroker::with_base_url(http, server.uri(), "k", "s");
        let bal = b.balance().await.unwrap();
        assert_eq!(bal.cash, 50000.5);
        assert_eq!(bal.equity, 62000.0);
        assert_eq!(bal.currency, "USD");
    }
}
