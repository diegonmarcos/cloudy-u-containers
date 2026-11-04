//! Risk metrics over a return series. All formulas take per-period returns.
//! `periods_per_year` handles annualization (252 for daily equity, 12 for
//! monthly, 4 for quarterly, 1 for annual).

use fincept_analytics_quant as q;

/// Annualized volatility = stddev(returns) * sqrt(periods_per_year).
#[must_use]
pub fn volatility(returns: &[f64], periods_per_year: f64) -> f64 {
    q::stddev(returns) * periods_per_year.sqrt()
}

/// Annualized Sharpe ratio.
/// `risk_free` is per-period. Returns 0 if volatility is zero.
#[must_use]
pub fn sharpe(returns: &[f64], risk_free: f64, periods_per_year: f64) -> f64 {
    let excess: Vec<f64> = returns.iter().map(|r| r - risk_free).collect();
    let mean = q::mean(&excess);
    let vol = q::stddev(&excess);
    if vol == 0.0 {
        return 0.0;
    }
    mean / vol * periods_per_year.sqrt()
}

/// Annualized Sortino ratio. Denominator is stddev of downside (negative)
/// returns only.
#[must_use]
pub fn sortino(returns: &[f64], risk_free: f64, periods_per_year: f64) -> f64 {
    let excess: Vec<f64> = returns.iter().map(|r| r - risk_free).collect();
    let mean = q::mean(&excess);
    let downside: Vec<f64> = excess.iter().filter(|&&r| r < 0.0).copied().collect();
    let dd = q::stddev(&downside);
    if dd == 0.0 {
        return 0.0;
    }
    mean / dd * periods_per_year.sqrt()
}

/// Historical Value at Risk at `alpha` confidence (e.g. 0.95 → 5% worst).
/// Returned as a positive number representing loss magnitude.
#[must_use]
pub fn historical_var(returns: &[f64], alpha: f64) -> f64 {
    if returns.is_empty() {
        return 0.0;
    }
    // VaR is the (1-alpha)th percentile of the return distribution.
    let p = (1.0 - alpha) * 100.0;
    let threshold = q::percentile(returns, p).unwrap_or(0.0);
    -threshold
}

/// Maximum drawdown of an equity curve derived from the return series.
/// Returns a negative number (peak-to-trough decline as a fraction).
#[must_use]
pub fn max_drawdown(returns: &[f64]) -> f64 {
    if returns.is_empty() {
        return 0.0;
    }
    let mut equity = 1.0_f64;
    let mut peak = 1.0_f64;
    let mut max_dd = 0.0_f64;
    for r in returns {
        equity *= 1.0 + r;
        if equity > peak {
            peak = equity;
        }
        let dd = equity / peak - 1.0;
        if dd < max_dd {
            max_dd = dd;
        }
    }
    max_dd
}

#[cfg(test)]
mod tests {
    use super::*;
    fn approx(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() <= tol, "{a} != {b} (tol {tol})");
    }

    #[test]
    fn vol_scales_with_sqrt_periods() {
        let r = vec![0.01, -0.01, 0.02, -0.02, 0.01];
        let v252 = volatility(&r, 252.0);
        let v1 = volatility(&r, 1.0);
        approx(v252 / v1, 252f64.sqrt(), 1e-9);
    }

    #[test]
    fn max_dd_basic() {
        // Returns +10%, -20% → equity: 1.0 → 1.1 → 0.88. DD peak 1.1 → 0.88 = -20%.
        approx(max_drawdown(&[0.1, -0.2]), -0.2, 1e-9);
    }

    #[test]
    fn hist_var_95() {
        // 100 returns from -0.05 to 0.05 step 0.001. 5th percentile ≈ -0.0455.
        let r: Vec<f64> = (0..100).map(|i| -0.05 + 0.001 * i as f64).collect();
        let var = historical_var(&r, 0.95);
        approx(var, 0.0455, 1e-3);
    }
}
