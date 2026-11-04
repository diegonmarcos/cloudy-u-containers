//! Portfolio construction primitives.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("empty input")]
    Empty,
    #[error("weight/return length mismatch")]
    LengthMismatch,
    #[error("variance must be positive")]
    InvalidVariance,
}

pub type Result<T> = std::result::Result<T, Error>;

/// Equal weights vector. `n` assets → each gets 1/n.
#[must_use]
pub fn equal_weights(n: usize) -> Vec<f64> {
    if n == 0 {
        return vec![];
    }
    vec![1.0 / n as f64; n]
}

/// Portfolio return given per-asset returns and weights (same shape).
/// Σ wᵢ * rᵢ
pub fn portfolio_return(weights: &[f64], asset_returns: &[f64]) -> Result<f64> {
    if weights.len() != asset_returns.len() {
        return Err(Error::LengthMismatch);
    }
    Ok(weights.iter().zip(asset_returns).map(|(w, r)| w * r).sum())
}

/// Two-asset minimum-variance portfolio weights (closed form).
/// Given σ₁², σ₂², ρ₁₂ → w* = (σ₂² − ρσ₁σ₂) / (σ₁² + σ₂² − 2ρσ₁σ₂)
pub fn min_variance_two_asset(var1: f64, var2: f64, corr: f64) -> Result<(f64, f64)> {
    if var1 <= 0.0 || var2 <= 0.0 {
        return Err(Error::InvalidVariance);
    }
    let s1 = var1.sqrt();
    let s2 = var2.sqrt();
    let cov = corr * s1 * s2;
    let denom = var1 + var2 - 2.0 * cov;
    if denom == 0.0 {
        return Err(Error::InvalidVariance);
    }
    let w1 = (var2 - cov) / denom;
    Ok((w1, 1.0 - w1))
}

/// Two-asset portfolio variance from weights, per-asset variances, correlation.
pub fn portfolio_variance_two(w1: f64, w2: f64, var1: f64, var2: f64, corr: f64) -> Result<f64> {
    if var1 < 0.0 || var2 < 0.0 {
        return Err(Error::InvalidVariance);
    }
    let cov = corr * var1.sqrt() * var2.sqrt();
    Ok(w1 * w1 * var1 + w2 * w2 * var2 + 2.0 * w1 * w2 * cov)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn approx(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() <= tol, "{a} != {b} (tol {tol})");
    }

    #[test]
    fn equal_weights_sum_to_one() {
        let w = equal_weights(4);
        approx(w.iter().sum::<f64>(), 1.0, 1e-12);
        assert_eq!(w.len(), 4);
    }

    #[test]
    fn portfolio_return_basic() {
        // 60/40 mix of 10%/5% = 8%
        approx(
            portfolio_return(&[0.6, 0.4], &[0.10, 0.05]).unwrap(),
            0.08,
            1e-12,
        );
    }

    #[test]
    fn min_var_two_asset_zero_corr() {
        // Equal variances + zero corr → equal weights 50/50.
        let (w1, w2) = min_variance_two_asset(0.04, 0.04, 0.0).unwrap();
        approx(w1, 0.5, 1e-12);
        approx(w2, 0.5, 1e-12);
    }
}
