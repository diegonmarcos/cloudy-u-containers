//! Paper-trading broker — in-memory matching engine.
//!
//! Model (intentionally simple for Phase 7a; event-driven extension in 7b):
//!   - Caller seeds a price via `set_price(symbol, price)` before placing.
//!   - Market orders fill immediately at the current seeded price.
//!   - Limit orders fill if the seeded price crosses the limit (buy when
//!     price ≤ limit; sell when price ≥ limit).
//!   - `tick(symbol, price)` updates the price and sweeps resting limits.
//!   - Balance (cash + equity) maintained against every fill.
//!
//! The engine is deterministic: no random slippage, no latency. Upstream
//! users layer those on top in simulations.

use async_trait::async_trait;
use chrono::Utc;
use fincept_brokers_core::{
    Balance, Broker, Error, Fill, Order, OrderRequest, OrderSide, OrderStatus, OrderType, Position,
    Result,
};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

struct State {
    orders: HashMap<String, Order>,
    fills: Vec<Fill>,
    positions: HashMap<String, Position>,
    prices: HashMap<String, f64>,
    cash: f64,
}

pub struct PaperBroker {
    id: String,
    state: Mutex<State>,
    next_id: AtomicU64,
}

impl PaperBroker {
    #[must_use]
    pub fn new(starting_cash: f64) -> Self {
        Self {
            id: "paper".into(),
            state: Mutex::new(State {
                orders: HashMap::new(),
                fills: Vec::new(),
                positions: HashMap::new(),
                prices: HashMap::new(),
                cash: starting_cash,
            }),
            next_id: AtomicU64::new(1),
        }
    }

    fn new_id(&self) -> String {
        format!("paper-{}", self.next_id.fetch_add(1, Ordering::Relaxed))
    }

    /// Seed the last trade price for a symbol. Does not trigger fills by itself.
    pub fn set_price(&self, symbol: &str, price: f64) {
        self.state.lock().prices.insert(symbol.to_string(), price);
    }

    /// Move the market and sweep any resting limit orders that now cross.
    pub fn tick(&self, symbol: &str, price: f64) {
        let mut s = self.state.lock();
        s.prices.insert(symbol.to_string(), price);
        // Collect ids to fill outside the retain() closure so we can drop
        // the borrow before mutating fills/positions/cash.
        let mut to_fill: Vec<String> = Vec::new();
        for (id, ord) in s.orders.iter() {
            if ord.symbol != symbol || ord.status != OrderStatus::Pending {
                continue;
            }
            if matches!(ord.order_type, OrderType::Limit) {
                if let Some(lim) = ord.limit_price {
                    let crosses = match ord.side {
                        OrderSide::Buy => price <= lim,
                        OrderSide::Sell => price >= lim,
                    };
                    if crosses {
                        to_fill.push(id.clone());
                    }
                }
            }
        }
        for id in to_fill {
            let _ = Self::fill_order(&mut s, &id, price);
        }
    }

    fn fill_order(state: &mut State, order_id: &str, price: f64) -> Result<()> {
        let ord = state
            .orders
            .get_mut(order_id)
            .ok_or_else(|| Error::OrderNotFound(order_id.into()))?;
        let qty = ord.quantity - ord.filled_quantity;
        if qty <= 0.0 {
            return Ok(());
        }

        // Cash/position update
        let signed_qty = match ord.side {
            OrderSide::Buy => qty,
            OrderSide::Sell => -qty,
        };
        let cash_delta = -signed_qty * price;
        let symbol = ord.symbol.clone();
        let side = ord.side;
        let new_cash = state.cash + cash_delta;
        if side == OrderSide::Buy && new_cash < 0.0 {
            ord.status = OrderStatus::Rejected;
            return Err(Error::InsufficientFunds {
                need: qty * price,
                have: state.cash,
            });
        }
        state.cash = new_cash;

        ord.filled_quantity += qty;
        ord.avg_fill_price = Some(price);
        ord.status = OrderStatus::Filled;
        ord.updated_at = Utc::now();

        state.fills.push(Fill {
            order_id: order_id.to_string(),
            symbol: symbol.clone(),
            side,
            quantity: qty,
            price,
            fee: 0.0,
            timestamp: Utc::now(),
        });

        // Weighted-average position update
        let pos = state
            .positions
            .entry(symbol.clone())
            .or_insert_with(|| Position {
                symbol: symbol.clone(),
                quantity: 0.0,
                avg_entry_price: 0.0,
                current_price: Some(price),
                unrealized_pnl: None,
            });
        let new_qty = pos.quantity + signed_qty;
        if pos.quantity.signum() == signed_qty.signum() || pos.quantity == 0.0 {
            // Adding to existing position (or opening) — blend entries.
            let old_notional = pos.quantity.abs() * pos.avg_entry_price;
            let added_notional = signed_qty.abs() * price;
            let total_qty = pos.quantity.abs() + signed_qty.abs();
            pos.avg_entry_price = if total_qty == 0.0 {
                0.0
            } else {
                (old_notional + added_notional) / total_qty
            };
        }
        pos.quantity = new_qty;
        pos.current_price = Some(price);
        pos.unrealized_pnl = Some((price - pos.avg_entry_price) * pos.quantity);
        Ok(())
    }
}

#[async_trait]
impl Broker for PaperBroker {
    fn id(&self) -> &str {
        &self.id
    }

    async fn connect(&self) -> Result<()> {
        Ok(())
    }

    async fn place_order(&self, req: OrderRequest) -> Result<Order> {
        let mut s = self.state.lock();
        let id = self.new_id();
        let now = Utc::now();
        let order = Order {
            id: id.clone(),
            client_order_id: req.client_order_id.clone(),
            symbol: req.symbol.clone(),
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
        };
        s.orders.insert(id.clone(), order.clone());

        // Market orders fill immediately at seeded price.
        if matches!(req.order_type, OrderType::Market) {
            let price = *s
                .prices
                .get(&req.symbol)
                .ok_or_else(|| Error::UnknownSymbol(req.symbol.clone()))?;
            Self::fill_order(&mut s, &id, price)?;
        }
        // Limit orders rest until tick() crosses; caller may also get
        // immediate fill if the seeded price already crosses.
        if matches!(req.order_type, OrderType::Limit) {
            if let (Some(price), Some(lim)) = (s.prices.get(&req.symbol).copied(), req.limit_price)
            {
                let crosses = match req.side {
                    OrderSide::Buy => price <= lim,
                    OrderSide::Sell => price >= lim,
                };
                if crosses {
                    Self::fill_order(&mut s, &id, price)?;
                }
            }
        }

        Ok(s.orders[&id].clone())
    }

    async fn cancel_order(&self, order_id: &str) -> Result<()> {
        let mut s = self.state.lock();
        let ord = s
            .orders
            .get_mut(order_id)
            .ok_or_else(|| Error::OrderNotFound(order_id.into()))?;
        if matches!(ord.status, OrderStatus::Filled) {
            return Err(Error::Rejected("already filled".into()));
        }
        ord.status = OrderStatus::Cancelled;
        ord.updated_at = Utc::now();
        Ok(())
    }

    async fn get_order(&self, order_id: &str) -> Result<Order> {
        self.state
            .lock()
            .orders
            .get(order_id)
            .cloned()
            .ok_or_else(|| Error::OrderNotFound(order_id.into()))
    }

    async fn list_orders(&self) -> Result<Vec<Order>> {
        Ok(self.state.lock().orders.values().cloned().collect())
    }

    async fn positions(&self) -> Result<Vec<Position>> {
        Ok(self
            .state
            .lock()
            .positions
            .values()
            .filter(|p| p.quantity != 0.0)
            .cloned()
            .collect())
    }

    async fn balance(&self) -> Result<Balance> {
        let s = self.state.lock();
        let equity: f64 = s.cash
            + s.positions
                .values()
                .map(|p| p.quantity * p.current_price.unwrap_or(p.avg_entry_price))
                .sum::<f64>();
        Ok(Balance {
            cash: s.cash,
            equity,
            currency: "USD".into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fincept_brokers_core::TimeInForce;

    fn buy(symbol: &str, qty: f64) -> OrderRequest {
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
    async fn market_buy_fills_immediately() {
        let b = PaperBroker::new(10_000.0);
        b.set_price("AAPL", 100.0);
        let ord = b.place_order(buy("AAPL", 10.0)).await.unwrap();
        assert_eq!(ord.status, OrderStatus::Filled);
        assert_eq!(ord.filled_quantity, 10.0);

        let pos = b.positions().await.unwrap();
        assert_eq!(pos.len(), 1);
        assert_eq!(pos[0].symbol, "AAPL");
        assert_eq!(pos[0].quantity, 10.0);
        assert_eq!(pos[0].avg_entry_price, 100.0);

        let bal = b.balance().await.unwrap();
        assert_eq!(bal.cash, 9_000.0);
        assert_eq!(bal.equity, 10_000.0);
    }

    #[tokio::test]
    async fn insufficient_funds_rejects() {
        let b = PaperBroker::new(500.0);
        b.set_price("AAPL", 100.0);
        let err = b.place_order(buy("AAPL", 10.0)).await.unwrap_err();
        assert!(matches!(err, Error::InsufficientFunds { .. }));
    }

    #[tokio::test]
    async fn limit_buy_rests_then_fills_on_tick() {
        let b = PaperBroker::new(10_000.0);
        b.set_price("AAPL", 110.0);
        let req = OrderRequest {
            symbol: "AAPL".into(),
            side: OrderSide::Buy,
            order_type: OrderType::Limit,
            quantity: 5.0,
            limit_price: Some(100.0),
            stop_price: None,
            time_in_force: TimeInForce::Gtc,
            client_order_id: None,
        };
        let ord = b.place_order(req).await.unwrap();
        assert_eq!(ord.status, OrderStatus::Pending);

        // Price crosses → fill on tick.
        b.tick("AAPL", 99.5);
        let ord = b.get_order(&ord.id).await.unwrap();
        assert_eq!(ord.status, OrderStatus::Filled);
        assert_eq!(ord.avg_fill_price, Some(99.5));
    }

    #[tokio::test]
    async fn cancel_pending_order() {
        let b = PaperBroker::new(10_000.0);
        b.set_price("AAPL", 110.0);
        let req = OrderRequest {
            symbol: "AAPL".into(),
            side: OrderSide::Buy,
            order_type: OrderType::Limit,
            quantity: 5.0,
            limit_price: Some(90.0),
            stop_price: None,
            time_in_force: TimeInForce::Gtc,
            client_order_id: None,
        };
        let ord = b.place_order(req).await.unwrap();
        b.cancel_order(&ord.id).await.unwrap();
        let ord = b.get_order(&ord.id).await.unwrap();
        assert_eq!(ord.status, OrderStatus::Cancelled);
    }

    #[tokio::test]
    async fn sell_reduces_position() {
        let b = PaperBroker::new(10_000.0);
        b.set_price("AAPL", 100.0);
        b.place_order(buy("AAPL", 10.0)).await.unwrap();
        // Now sell 4 at a higher price.
        b.set_price("AAPL", 110.0);
        let req = OrderRequest {
            symbol: "AAPL".into(),
            side: OrderSide::Sell,
            order_type: OrderType::Market,
            quantity: 4.0,
            limit_price: None,
            stop_price: None,
            time_in_force: TimeInForce::Day,
            client_order_id: None,
        };
        b.place_order(req).await.unwrap();
        let pos = b.positions().await.unwrap();
        assert_eq!(pos[0].quantity, 6.0);
        // Cash: 10k - 10*100 + 4*110 = 9440
        assert_eq!(b.balance().await.unwrap().cash, 9_440.0);
    }
}
