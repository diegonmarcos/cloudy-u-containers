//! Option pricing primitives. European options only in Phase 4.

use statrs::distribution::{ContinuousCDF, Normal};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("invalid input: {0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Standard normal CDF.
fn norm_cdf(x: f64) -> f64 {
    // `new` with mean=0 stddev=1 never fails; unwrap is safe.
    let n = Normal::new(0.0, 1.0).expect("N(0,1) constructible");
    n.cdf(x)
}

/// Black-Scholes-Merton European call price.
///
/// - `s`: spot
/// - `k`: strike
/// - `r`: continuously compounded risk-free rate
/// - `sigma`: volatility
/// - `t`: time to expiry (years)
pub fn black_scholes_call(s: f64, k: f64, r: f64, sigma: f64, t: f64) -> Result<f64> {
    if s <= 0.0 || k <= 0.0 || sigma <= 0.0 || t <= 0.0 {
        return Err(Error::Invalid("s, k, sigma, t must be > 0".into()));
    }
    let d1 = ((s / k).ln() + (r + 0.5 * sigma * sigma) * t) / (sigma * t.sqrt());
    let d2 = d1 - sigma * t.sqrt();
    Ok(s * norm_cdf(d1) - k * (-r * t).exp() * norm_cdf(d2))
}

/// Black-Scholes-Merton European put price.
pub fn black_scholes_put(s: f64, k: f64, r: f64, sigma: f64, t: f64) -> Result<f64> {
    if s <= 0.0 || k <= 0.0 || sigma <= 0.0 || t <= 0.0 {
        return Err(Error::Invalid("s, k, sigma, t must be > 0".into()));
    }
    let d1 = ((s / k).ln() + (r + 0.5 * sigma * sigma) * t) / (sigma * t.sqrt());
    let d2 = d1 - sigma * t.sqrt();
    Ok(k * (-r * t).exp() * norm_cdf(-d2) - s * norm_cdf(-d1))
}

/// Cox-Ross-Rubinstein binomial tree for European call. `steps` ≥ 1.
pub fn binomial_european_call(
    s: f64,
    k: f64,
    r: f64,
    sigma: f64,
    t: f64,
    steps: u32,
) -> Result<f64> {
    if steps == 0 {
        return Err(Error::Invalid("steps must be >= 1".into()));
    }
    let dt = t / steps as f64;
    let u = (sigma * dt.sqrt()).exp();
    let d = 1.0 / u;
    let p = ((r * dt).exp() - d) / (u - d);
    let mut prices: Vec<f64> = (0..=steps)
        .map(|i| {
            let st = s * u.powi((steps - i) as i32) * d.powi(i as i32);
            (st - k).max(0.0)
        })
        .collect();
    for step in (0..steps).rev() {
        for i in 0..=step {
            prices[i as usize] =
                (-r * dt).exp() * (p * prices[i as usize] + (1.0 - p) * prices[i as usize + 1]);
        }
    }
    Ok(prices[0])
}

#[cfg(test)]
mod tests {
    use super::*;
    fn approx(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() <= tol, "{a} != {b} (tol {tol})");
    }

    /// Hull 7e example: S=42, K=40, r=10%, σ=20%, T=0.5 → call ≈ 4.76, put ≈ 0.81.
    #[test]
    fn hull_bs_example_call() {
        approx(
            black_scholes_call(42.0, 40.0, 0.10, 0.20, 0.5).unwrap(),
            4.7594,
            1e-3,
        );
    }
    #[test]
    fn hull_bs_example_put() {
        approx(
            black_scholes_put(42.0, 40.0, 0.10, 0.20, 0.5).unwrap(),
            0.8086,
            1e-3,
        );
    }

    #[test]
    fn binomial_converges_to_bs() {
        let bs = black_scholes_call(42.0, 40.0, 0.10, 0.20, 0.5).unwrap();
        let bin = binomial_european_call(42.0, 40.0, 0.10, 0.20, 0.5, 500).unwrap();
        approx(bin, bs, 0.05);
    }
}
