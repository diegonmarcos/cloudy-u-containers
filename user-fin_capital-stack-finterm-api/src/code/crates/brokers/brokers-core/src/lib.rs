//! Broker-agnostic contract.
//!
//! Every adapter (Alpaca, Zerodha, IBKR, …) and the paper engine implement
//! `Broker`. Unified types let the rest of the app stay broker-ignorant — the
//! trading engine treats them interchangeably.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("not connected")]
    NotConnected,
    #[error("auth failed: {0}")]
    Auth(String),
    #[error("rejected: {0}")]
    Rejected(String),
    #[error("symbol not found: {0}")]
    UnknownSymbol(String),
    #[error("order not found: {0}")]
    OrderNotFound(String),
    #[error("insufficient funds: need {need}, have {have}")]
    InsufficientFunds { need: f64, have: f64 },
    #[error("vendor: {0}")]
    Vendor(String),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderSide {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderType {
    Market,
    Limit,
    Stop,
    StopLimit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeInForce {
    Day,
    Gtc,
    Ioc,
    Fok,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrderStatus {
    Pending,
    Filled,
    PartiallyFilled,
    Cancelled,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderRequest {
    pub symbol: String,
    pub side: OrderSide,
    pub order_type: OrderType,
    pub quantity: f64,
    /// Required when order_type ∈ {Limit, StopLimit}.
    pub limit_price: Option<f64>,
    /// Required when order_type ∈ {Stop, StopLimit}.
    pub stop_price: Option<f64>,
    pub time_in_force: TimeInForce,
    /// Caller-owned idempotency key. Useful to dedup retries.
    pub client_order_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub id: String,
    pub client_order_id: Option<String>,
    pub symbol: String,
    pub side: OrderSide,
    pub order_type: OrderType,
    pub quantity: f64,
    pub filled_quantity: f64,
    pub avg_fill_price: Option<f64>,
    pub limit_price: Option<f64>,
    pub stop_price: Option<f64>,
    pub status: OrderStatus,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fill {
    pub order_id: String,
    pub symbol: String,
    pub side: OrderSide,
    pub quantity: f64,
    pub price: f64,
    pub fee: f64,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub symbol: String,
    /// Signed: positive = long, negative = short, zero = flat.
    pub quantity: f64,
    pub avg_entry_price: f64,
    pub current_price: Option<f64>,
    pub unrealized_pnl: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Balance {
    pub cash: f64,
    pub equity: f64,
    pub currency: String,
}

// ── The trait every adapter implements ───────────────────────────────────────

#[async_trait]
pub trait Broker: Send + Sync {
    fn id(&self) -> &str;
    async fn connect(&self) -> Result<()>;
    async fn place_order(&self, req: OrderRequest) -> Result<Order>;
    async fn cancel_order(&self, order_id: &str) -> Result<()>;
    async fn get_order(&self, order_id: &str) -> Result<Order>;
    async fn list_orders(&self) -> Result<Vec<Order>>;
    async fn positions(&self) -> Result<Vec<Position>>;
    async fn balance(&self) -> Result<Balance>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_request_serde_roundtrip() {
        let req = OrderRequest {
            symbol: "AAPL".into(),
            side: OrderSide::Buy,
            order_type: OrderType::Limit,
            quantity: 100.0,
            limit_price: Some(150.0),
            stop_price: None,
            time_in_force: TimeInForce::Day,
            client_order_id: Some("c1".into()),
        };
        let j = serde_json::to_string(&req).unwrap();
        let back: OrderRequest = serde_json::from_str(&j).unwrap();
        assert_eq!(back.symbol, "AAPL");
        assert_eq!(back.side, OrderSide::Buy);
        assert_eq!(back.order_type, OrderType::Limit);
    }

    #[test]
    fn position_pnl_math() {
        let mut p = Position {
            symbol: "AAPL".into(),
            quantity: 100.0,
            avg_entry_price: 100.0,
            current_price: Some(110.0),
            unrealized_pnl: None,
        };
        // Caller computes; we just verify shape.
        p.unrealized_pnl = p
            .current_price
            .map(|cp| (cp - p.avg_entry_price) * p.quantity);
        assert_eq!(p.unrealized_pnl, Some(1000.0));
    }
}
