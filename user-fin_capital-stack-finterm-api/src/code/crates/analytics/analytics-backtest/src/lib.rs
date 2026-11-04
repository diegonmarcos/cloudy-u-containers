//! Backtesting primitives. Event-driven engine ships Phase 4b; this
//! module covers vectorized return-stream math used by most metrics.

/// Equity curve from a per-period return series, starting at `initial`.
/// equity[i] = initial * Π (1 + r_j) for j ≤ i.
#[must_use]
pub fn equity_curve(returns: &[f64], initial: f64) -> Vec<f64> {
    let mut out = Vec::with_capacity(returns.len());
    let mut eq = initial;
    for r in returns {
        eq *= 1.0 + r;
        out.push(eq);
    }
    out
}

/// Total return (cumulative). Π(1+r) − 1.
#[must_use]
pub fn total_return(returns: &[f64]) -> f64 {
    if returns.is_empty() {
        return 0.0;
    }
    returns.iter().fold(1.0, |acc, r| acc * (1.0 + r)) - 1.0
}

/// Compound annual growth rate (CAGR).
/// (1 + total)^(periods_per_year / n) − 1
#[must_use]
pub fn annualized_return(returns: &[f64], periods_per_year: f64) -> f64 {
    let n = returns.len() as f64;
    if n == 0.0 {
        return 0.0;
    }
    let total = total_return(returns);
    (1.0 + total).powf(periods_per_year / n) - 1.0
}

/// Calmar ratio = annualized return / |max drawdown|.
/// Returns 0 if drawdown is 0 (avoid div by zero).
#[must_use]
pub fn calmar(returns: &[f64], periods_per_year: f64) -> f64 {
    let ann = annualized_return(returns, periods_per_year);
    let dd = fincept_analytics_risk::max_drawdown(returns).abs();
    if dd == 0.0 {
        return 0.0;
    }
    ann / dd
}

#[cfg(test)]
mod tests {
    use super::*;
    fn approx(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() <= tol, "{a} != {b} (tol {tol})");
    }

    #[test]
    fn equity_curve_basic() {
        let eq = equity_curve(&[0.1, -0.05], 1000.0);
        approx(eq[0], 1100.0, 1e-9);
        approx(eq[1], 1045.0, 1e-9);
    }

    #[test]
    fn total_return_compounds() {
        // 10% then 10% → 21%
        approx(total_return(&[0.1, 0.1]), 0.21, 1e-12);
    }

    #[test]
    fn annualized_from_monthly() {
        // 12 months of 1% → (1.01)^12 − 1 ≈ 0.12682...
        let r = vec![0.01; 12];
        approx(annualized_return(&r, 12.0), 0.12682503, 1e-7);
    }
}
