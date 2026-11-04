//! High-frequency / microstructure metrics.

use ndarray::{Array1, Array2};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("length mismatch")]
    LengthMismatch,
    #[error("invalid book: bid >= ask")]
    InvalidBook,
    #[error("empty input")]
    Empty,
}

pub type Result<T> = std::result::Result<T, Error>;

/// Quoted spread in price units: ask − bid.
pub fn spread(bid: f64, ask: f64) -> Result<f64> {
    if ask <= bid {
        return Err(Error::InvalidBook);
    }
    Ok(ask - bid)
}

/// Quoted spread as fraction of mid-price: (ask − bid) / mid.
pub fn relative_spread(bid: f64, ask: f64) -> Result<f64> {
    if ask <= bid {
        return Err(Error::InvalidBook);
    }
    let mid = 0.5 * (ask + bid);
    Ok((ask - bid) / mid)
}

/// Order-book imbalance from top-of-book sizes.
/// I = (bid_size − ask_size) / (bid_size + ask_size), ∈ [−1, +1].
pub fn order_imbalance(bid_size: f64, ask_size: f64) -> Result<f64> {
    let s = bid_size + ask_size;
    if s <= 0.0 {
        return Err(Error::Empty);
    }
    Ok((bid_size - ask_size) / s)
}

/// Volume-weighted average price: Σ p·v / Σ v.
pub fn vwap(prices: &[f64], volumes: &[f64]) -> Result<f64> {
    if prices.len() != volumes.len() {
        return Err(Error::LengthMismatch);
    }
    if prices.is_empty() {
        return Err(Error::Empty);
    }
    let num: f64 = prices.iter().zip(volumes).map(|(p, v)| p * v).sum();
    let den: f64 = volumes.iter().sum();
    if den == 0.0 {
        return Err(Error::Empty);
    }
    Ok(num / den)
}

/// Kyle's lambda (price-impact coefficient): slope of the OLS regression
/// Δprice = α + λ · signed_volume + ε.
/// Signed volume is +qty for buyer-initiated trades, −qty for seller-initiated.
/// Returns λ (units: price per unit signed volume).
pub fn kyle_lambda(price_changes: &[f64], signed_volumes: &[f64]) -> Result<f64> {
    if price_changes.len() != signed_volumes.len() {
        return Err(Error::LengthMismatch);
    }
    let n = price_changes.len();
    if n < 2 {
        return Err(Error::Empty);
    }
    // Design matrix with intercept column.
    let mut x = Array2::<f64>::zeros((n, 2));
    for i in 0..n {
        x[[i, 0]] = 1.0;
        x[[i, 1]] = signed_volumes[i];
    }
    let y = Array1::from(price_changes.to_vec());
    let beta = fincept_ml_candle::ols_fit(&x, &y).map_err(|_| Error::Empty)?;
    Ok(beta[1])
}

#[cfg(test)]
mod tests {
    use super::*;
    fn approx(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() <= tol, "{a} != {b} (tol {tol})");
    }

    #[test]
    fn spread_basic() {
        approx(spread(100.0, 100.05).unwrap(), 0.05, 1e-12);
    }

    #[test]
    fn imbalance_all_bid() {
        approx(order_imbalance(100.0, 0.0).unwrap(), 1.0, 1e-12);
    }

    #[test]
    fn imbalance_balanced() {
        approx(order_imbalance(50.0, 50.0).unwrap(), 0.0, 1e-12);
    }

    #[test]
    fn vwap_simple() {
        // p=[10,12], v=[100,300] → (10*100 + 12*300)/400 = 11.5
        approx(vwap(&[10.0, 12.0], &[100.0, 300.0]).unwrap(), 11.5, 1e-12);
    }

    #[test]
    fn kyle_lambda_recovers_slope() {
        // Synthetic: dp = 0.001 * signed_vol, λ should be 0.001.
        let vols: Vec<f64> = (-50..=50).map(|v| v as f64).collect();
        let dps: Vec<f64> = vols.iter().map(|v| 0.001 * v).collect();
        approx(kyle_lambda(&dps, &vols).unwrap(), 0.001, 1e-10);
    }
}
