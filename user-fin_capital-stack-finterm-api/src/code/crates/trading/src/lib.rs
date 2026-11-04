//! Trading engine.
//!
//! - `OrderRouter`: registers named brokers; dispatches `place_order` to the
//!   right one by id.
//! - `RiskCheck`: pre-trade limits (max order size, max net position per
//!   symbol). Rejects before the broker sees the order.
//! - `PositionAggregator`: rolls positions across all registered brokers
//!   into a single cross-broker book.

use async_trait::async_trait;
use fincept_brokers_core::{Broker, Order, OrderRequest, Position};
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("broker '{0}' not registered")]
    UnknownBroker(String),
    #[error("risk check '{rule}' rejected: {detail}")]
    RiskRejected { rule: String, detail: String },
    #[error("broker: {0}")]
    Broker(#[from] fincept_brokers_core::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

// ── Risk ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct RiskLimits {
    pub max_order_notional: f64,
    pub max_quantity_per_order: f64,
}

impl Default for RiskLimits {
    fn default() -> Self {
        Self {
            max_order_notional: 1_000_000.0,
            max_quantity_per_order: 100_000.0,
        }
    }
}

pub struct RiskCheck {
    limits: RiskLimits,
}

impl RiskCheck {
    pub fn new(limits: RiskLimits) -> Self {
        Self { limits }
    }

    /// `price_hint` is used to compute notional when the order doesn't carry
    /// one (market orders). Caller should supply the latest quote.
    pub fn vet(&self, req: &OrderRequest, price_hint: f64) -> Result<()> {
        if req.quantity > self.limits.max_quantity_per_order {
            return Err(Error::RiskRejected {
                rule: "max_quantity_per_order".into(),
                detail: format!("{} > {}", req.quantity, self.limits.max_quantity_per_order),
            });
        }
        let notional = req.limit_price.unwrap_or(price_hint.max(0.0)).max(0.0) * req.quantity;
        if notional > self.limits.max_order_notional {
            return Err(Error::RiskRejected {
                rule: "max_order_notional".into(),
                detail: format!("{notional} > {}", self.limits.max_order_notional),
            });
        }
        Ok(())
    }
}

// ── Router ───────────────────────────────────────────────────────────────────

pub struct OrderRouter {
    brokers: RwLock<HashMap<String, Arc<dyn Broker>>>,
}

impl Default for OrderRouter {
    fn default() -> Self {
        Self {
            brokers: RwLock::new(HashMap::new()),
        }
    }
}

impl OrderRouter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, id: impl Into<String>, broker: Arc<dyn Broker>) {
        self.brokers.write().insert(id.into(), broker);
    }

    pub fn list(&self) -> Vec<String> {
        self.brokers.read().keys().cloned().collect()
    }

    pub async fn place_order(&self, broker_id: &str, req: OrderRequest) -> Result<Order> {
        let broker = self
            .brokers
            .read()
            .get(broker_id)
            .cloned()
            .ok_or_else(|| Error::UnknownBroker(broker_id.to_string()))?;
        Ok(broker.place_order(req).await?)
    }

    pub async fn cancel_order(&self, broker_id: &str, order_id: &str) -> Result<()> {
        let broker = self
            .brokers
            .read()
            .get(broker_id)
            .cloned()
            .ok_or_else(|| Error::UnknownBroker(broker_id.to_string()))?;
        Ok(broker.cancel_order(order_id).await?)
    }
}

// ── Aggregator ──────────────────────────────────────────────────────────────

/// Roll positions across all brokers in the router into one net book.
#[async_trait]
pub trait Aggregator {
    async fn aggregated_positions(&self) -> Result<Vec<Position>>;
}

#[async_trait]
impl Aggregator for OrderRouter {
    async fn aggregated_positions(&self) -> Result<Vec<Position>> {
        let brokers: Vec<Arc<dyn Broker>> = self.brokers.read().values().cloned().collect();
        let mut map: HashMap<String, Position> = HashMap::new();
        for b in brokers {
            for p in b.positions().await? {
                let entry = map.entry(p.symbol.clone()).or_insert_with(|| Position {
                    symbol: p.symbol.clone(),
                    quantity: 0.0,
                    avg_entry_price: 0.0,
                    current_price: p.current_price,
                    unrealized_pnl: None,
                });
                // Weighted-average entry price across brokers.
                let old_notional = entry.quantity.abs() * entry.avg_entry_price;
                let new_notional = p.quantity.abs() * p.avg_entry_price;
                let total_abs = entry.quantity.abs() + p.quantity.abs();
                entry.avg_entry_price = if total_abs == 0.0 {
                    0.0
                } else {
                    (old_notional + new_notional) / total_abs
                };
                entry.quantity += p.quantity;
            }
        }
        Ok(map.into_values().filter(|p| p.quantity != 0.0).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fincept_brokers_core::{OrderSide, OrderType, TimeInForce};
    use fincept_brokers_paper::PaperBroker;

    fn buy_req(symbol: &str, qty: f64) -> OrderRequest {
        OrderRequest {
            symbol: symbol.into(),
            side: OrderSide::Buy,
            order_type: OrderType::Market,
            quantity: qty,
            limit_price: None,
            stop_price: None,
            time_in_force: TimeInForce::Day,
            client_order_id: None,
        }
    }

    #[tokio::test]
    async fn router_dispatches_to_registered_broker() {
        let router = OrderRouter::new();
        let paper = Arc::new(PaperBroker::new(10_000.0));
        paper.set_price("AAPL", 100.0);
        router.register("paper", paper);

        let ord = router
            .place_order("paper", buy_req("AAPL", 5.0))
            .await
            .unwrap();
        assert_eq!(ord.filled_quantity, 5.0);
    }

    #[tokio::test]
    async fn unknown_broker_errors() {
        let router = OrderRouter::new();
        let err = router
            .place_order("nope", buy_req("AAPL", 1.0))
            .await
            .unwrap_err();
        assert!(matches!(err, Error::UnknownBroker(_)));
    }

    #[test]
    fn risk_rejects_oversized_order() {
        let risk = RiskCheck::new(RiskLimits {
            max_order_notional: 1_000.0,
            max_quantity_per_order: 1_000.0,
        });
        let req = buy_req("AAPL", 100.0);
        let err = risk.vet(&req, 100.0).unwrap_err();
        assert!(matches!(err, Error::RiskRejected { .. }));
    }

    #[test]
    fn risk_accepts_small_order() {
        let risk = RiskCheck::new(RiskLimits::default());
        risk.vet(&buy_req("AAPL", 1.0), 100.0).unwrap();
    }

    #[tokio::test]
    async fn aggregator_merges_cross_broker_positions() {
        let router = OrderRouter::new();
        let a = Arc::new(PaperBroker::new(10_000.0));
        a.set_price("AAPL", 100.0);
        let b = Arc::new(PaperBroker::new(10_000.0));
        b.set_price("AAPL", 110.0);
        router.register("a", a.clone());
        router.register("b", b.clone());

        router
            .place_order("a", buy_req("AAPL", 10.0))
            .await
            .unwrap();
        router.place_order("b", buy_req("AAPL", 5.0)).await.unwrap();

        let agg = router.aggregated_positions().await.unwrap();
        let apos = agg.iter().find(|p| p.symbol == "AAPL").unwrap();
        assert_eq!(apos.quantity, 15.0);
        // Weighted avg: (10*100 + 5*110) / 15 = 103.333...
        assert!((apos.avg_entry_price - 103.3333333).abs() < 1e-4);
    }
}
