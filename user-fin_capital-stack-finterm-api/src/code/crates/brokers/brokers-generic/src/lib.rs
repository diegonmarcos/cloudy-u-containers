//! Spec-driven broker.
//!
//! Phase 7 goal: most broker REST APIs share the same shape (POST /orders,
//! GET /orders/:id, GET /positions, GET /account). Rather than writing a
//! crate per broker, one `BrokerSpec` declares the endpoint paths + auth
//! header name + JSON field mappings, and this crate interprets it.
//!
//! Custom brokers with odd auth flows (OAuth dances, signed payloads, SOAP)
//! still get their own crate — see `brokers-alpaca` for the template.

use async_trait::async_trait;
use chrono::Utc;
use fincept_brokers_core::{
    Balance, Broker, Error, Order, OrderRequest, OrderStatus, Position, Result,
};
use fincept_http::Client;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerSpec {
    pub id: String,
    pub description: String,
    pub base_url: String,
    pub region: String,
    pub auth: AuthScheme,
    pub endpoints: Endpoints,
    pub fields: FieldMap,
    pub test: TestFixture,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthScheme {
    /// Header to set for auth (e.g. "Authorization", "X-Api-Key"). Empty string = none.
    pub header: String,
    /// Prefix applied to the token value ("Bearer ", "" for raw keys).
    #[serde(default)]
    pub prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Endpoints {
    pub place_order: String,
    pub cancel_order: String,
    pub get_order: String,
    pub list_orders: String,
    pub positions: String,
    pub balance: String,
}

/// JSON pointers that tell the adapter where to find each logical field in
/// the vendor's raw payload. Example:
///   order_id → "/id"
///   cash → "/cash"
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldMap {
    pub order_id: String,
    pub order_status: String,
    pub cash: String,
    pub equity: String,
    pub positions: String,
    pub position_symbol: String,
    pub position_qty: String,
    pub position_avg_price: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestFixture {
    pub place_order_response: serde_json::Value,
    pub get_order_response: serde_json::Value,
    pub positions_response: serde_json::Value,
    pub balance_response: serde_json::Value,
}

pub struct GenericBroker {
    http: Client,
    spec: BrokerSpec,
    token: String,
    base_url_override: Option<String>,
}

impl GenericBroker {
    pub fn new(http: Client, spec: BrokerSpec, token: impl Into<String>) -> Self {
        Self {
            http,
            spec,
            token: token.into(),
            base_url_override: None,
        }
    }

    #[must_use]
    pub fn with_base_url(mut self, base: impl Into<String>) -> Self {
        self.base_url_override = Some(base.into());
        self
    }

    fn base_url(&self) -> &str {
        self.base_url_override
            .as_deref()
            .unwrap_or(&self.spec.base_url)
    }

    fn url(&self, path: &str, params: &BTreeMap<String, String>) -> String {
        let mut p = path.to_string();
        for (k, v) in params {
            p = p.replace(&format!("{{{k}}}"), v);
        }
        format!("{}{}", self.base_url(), p)
    }

    fn auth_header(&self) -> Option<(String, String)> {
        if self.spec.auth.header.is_empty() {
            None
        } else {
            Some((
                self.spec.auth.header.clone(),
                format!("{}{}", self.spec.auth.prefix, self.token),
            ))
        }
    }

    async fn get_json(&self, url: &str) -> Result<serde_json::Value> {
        let mut req = self.http.reqwest().get(url);
        if let Some((h, v)) = self.auth_header() {
            req = req.header(h, v);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| Error::Vendor(e.to_string()))?
            .error_for_status()
            .map_err(|e| Error::Vendor(e.to_string()))?;
        resp.json().await.map_err(|e| Error::Vendor(e.to_string()))
    }

    async fn post_json(&self, url: &str, body: &serde_json::Value) -> Result<serde_json::Value> {
        let mut req = self.http.reqwest().post(url).json(body);
        if let Some((h, v)) = self.auth_header() {
            req = req.header(h, v);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| Error::Vendor(e.to_string()))?
            .error_for_status()
            .map_err(|e| Error::Vendor(e.to_string()))?;
        resp.json().await.map_err(|e| Error::Vendor(e.to_string()))
    }
}

#[async_trait]
impl Broker for GenericBroker {
    fn id(&self) -> &str {
        &self.spec.id
    }

    async fn connect(&self) -> Result<()> {
        // Most REST-auth brokers have no explicit connect step. Subclasses
        // with OAuth dances need a custom adapter.
        Ok(())
    }

    async fn place_order(&self, req: OrderRequest) -> Result<Order> {
        let url = self.url(&self.spec.endpoints.place_order, &BTreeMap::new());
        let body = serde_json::to_value(&req)?;
        let raw = self.post_json(&url, &body).await?;
        let id = raw
            .pointer(&self.spec.fields.order_id)
            .and_then(|v| v.as_str())
            .ok_or_else(|| Error::Vendor("missing order_id pointer".into()))?
            .to_string();
        let now = Utc::now();
        Ok(Order {
            id,
            client_order_id: req.client_order_id,
            symbol: req.symbol,
            side: req.side,
            order_type: req.order_type,
            quantity: req.quantity,
            filled_quantity: 0.0,
            avg_fill_price: None,
            limit_price: req.limit_price,
            stop_price: req.stop_price,
            status: OrderStatus::Pending,
            created_at: now,
            updated_at: now,
        })
    }

    async fn cancel_order(&self, order_id: &str) -> Result<()> {
        let mut params = BTreeMap::new();
        params.insert("id".into(), order_id.to_string());
        let url = self.url(&self.spec.endpoints.cancel_order, &params);
        let mut req = self.http.reqwest().delete(&url);
        if let Some((h, v)) = self.auth_header() {
            req = req.header(h, v);
        }
        req.send()
            .await
            .map_err(|e| Error::Vendor(e.to_string()))?
            .error_for_status()
            .map_err(|e| Error::Vendor(e.to_string()))?;
        Ok(())
    }

    async fn get_order(&self, order_id: &str) -> Result<Order> {
        let mut params = BTreeMap::new();
        params.insert("id".into(), order_id.to_string());
        let url = self.url(&self.spec.endpoints.get_order, &params);
        let raw = self.get_json(&url).await?;
        let id = raw
            .pointer(&self.spec.fields.order_id)
            .and_then(|v| v.as_str())
            .unwrap_or(order_id)
            .to_string();
        let status_str = raw
            .pointer(&self.spec.fields.order_status)
            .and_then(|v| v.as_str())
            .unwrap_or("pending");
        let status = match status_str.to_lowercase().as_str() {
            "filled" => OrderStatus::Filled,
            "partially_filled" | "partial" => OrderStatus::PartiallyFilled,
            "cancelled" | "canceled" => OrderStatus::Cancelled,
            "rejected" => OrderStatus::Rejected,
            _ => OrderStatus::Pending,
        };
        let now = Utc::now();
        Ok(Order {
            id,
            client_order_id: None,
            symbol: String::new(),
            side: fincept_brokers_core::OrderSide::Buy,
            order_type: fincept_brokers_core::OrderType::Market,
            quantity: 0.0,
            filled_quantity: 0.0,
            avg_fill_price: None,
            limit_price: None,
            stop_price: None,
            status,
            created_at: now,
            updated_at: now,
        })
    }

    async fn list_orders(&self) -> Result<Vec<Order>> {
        // Spec-driven brokers return list-of-orders from a single endpoint;
        // full deserialization is vendor-specific — Phase 7b extends the spec
        // with per-field mappings. Return empty for now.
        let _ = self
            .get_json(&self.url(&self.spec.endpoints.list_orders, &BTreeMap::new()))
            .await?;
        Ok(vec![])
    }

    async fn positions(&self) -> Result<Vec<Position>> {
        let url = self.url(&self.spec.endpoints.positions, &BTreeMap::new());
        let raw = self.get_json(&url).await?;
        let arr = raw
            .pointer(&self.spec.fields.positions)
            .and_then(|v| v.as_array())
            .ok_or_else(|| Error::Vendor("positions pointer missing or not array".into()))?;
        Ok(arr
            .iter()
            .map(|p| Position {
                symbol: p
                    .pointer(&self.spec.fields.position_symbol)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                quantity: p
                    .pointer(&self.spec.fields.position_qty)
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0),
                avg_entry_price: p
                    .pointer(&self.spec.fields.position_avg_price)
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0),
                current_price: None,
                unrealized_pnl: None,
            })
            .collect())
    }

    async fn balance(&self) -> Result<Balance> {
        let url = self.url(&self.spec.endpoints.balance, &BTreeMap::new());
        let raw = self.get_json(&url).await?;
        Ok(Balance {
            cash: raw
                .pointer(&self.spec.fields.cash)
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0),
            equity: raw
                .pointer(&self.spec.fields.equity)
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0),
            currency: "USD".into(),
        })
    }
}

pub async fn validate_spec(spec: &BrokerSpec, http: Client, base_url: &str) -> Result<()> {
    let b = GenericBroker::new(http, spec.clone(), "test-token").with_base_url(base_url);
    // Positions + balance fetch — exercises GET + pointer extraction.
    let _ = b.positions().await?;
    let _ = b.balance().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_map_parses_pointers() {
        let m = FieldMap {
            order_id: "/id".into(),
            order_status: "/status".into(),
            cash: "/cash".into(),
            equity: "/equity".into(),
            positions: "/positions".into(),
            position_symbol: "/symbol".into(),
            position_qty: "/qty".into(),
            position_avg_price: "/avg_price".into(),
        };
        let payload = serde_json::json!({
            "id": "o1", "status": "filled", "cash": 100.0, "equity": 110.0
        });
        assert_eq!(
            payload.pointer(&m.order_id).and_then(|v| v.as_str()),
            Some("o1")
        );
        assert_eq!(
            payload.pointer(&m.cash).and_then(|v| v.as_f64()),
            Some(100.0)
        );
    }
}
