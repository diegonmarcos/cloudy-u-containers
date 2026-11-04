//! Factor discovery primitives.
//!
//! The Information Coefficient (IC) is the cross-sectional correlation
//! between a factor value and its realized forward return. Rank IC (Spearman)
//! is the usual metric in quant research because it's robust to non-linear
//! monotone transformations.

use fincept_analytics_quant as q;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("length mismatch: {a} vs {b}")]
    LengthMismatch { a: usize, b: usize },
    #[error("empty input")]
    Empty,
}

pub type Result<T> = std::result::Result<T, Error>;

/// Pearson correlation between two series of equal length.
pub fn pearson(x: &[f64], y: &[f64]) -> Result<f64> {
    if x.len() != y.len() {
        return Err(Error::LengthMismatch {
            a: x.len(),
            b: y.len(),
        });
    }
    if x.is_empty() {
        return Err(Error::Empty);
    }
    let mx = q::mean(x);
    let my = q::mean(y);
    let mut num = 0.0;
    let mut dx = 0.0;
    let mut dy = 0.0;
    for (a, b) in x.iter().zip(y) {
        let ax = a - mx;
        let by = b - my;
        num += ax * by;
        dx += ax * ax;
        dy += by * by;
    }
    let denom = (dx * dy).sqrt();
    if denom == 0.0 {
        return Ok(0.0);
    }
    Ok(num / denom)
}

/// Spearman rank correlation = Pearson correlation of the ranks.
/// Ties are averaged (fractional rank) — matches scipy.stats.spearmanr default.
pub fn spearman(x: &[f64], y: &[f64]) -> Result<f64> {
    if x.len() != y.len() {
        return Err(Error::LengthMismatch {
            a: x.len(),
            b: y.len(),
        });
    }
    let rx = rank_avg(x);
    let ry = rank_avg(y);
    pearson(&rx, &ry)
}

/// Assign average ranks to a vector. Equal values share the mean of their
/// positions — canonical "fractional" rank used by scipy.
fn rank_avg(v: &[f64]) -> Vec<f64> {
    let n = v.len();
    let mut idx: Vec<usize> = (0..n).collect();
    idx.sort_by(|&a, &b| v[a].partial_cmp(&v[b]).unwrap_or(std::cmp::Ordering::Equal));
    let mut ranks = vec![0.0_f64; n];
    let mut i = 0;
    while i < n {
        let mut j = i + 1;
        while j < n && v[idx[j]] == v[idx[i]] {
            j += 1;
        }
        // average rank = (i+1 + j)/2 when ranks are 1-indexed → (i+j+1)/2
        let avg = (i + j + 1) as f64 / 2.0;
        for k in i..j {
            ranks[idx[k]] = avg;
        }
        i = j;
    }
    ranks
}

/// Rolling Information Coefficient — cross-sectional Spearman between
/// `factor[t]` and `forward_return[t]` at each timestep. Returns the per-t
/// series.
///
/// `factor` and `forward_return` are 2D row-major: each row is a timestep,
/// each column is an asset. Expressed here as `&[Vec<f64>]` for simplicity.
pub fn rolling_rank_ic(factor: &[Vec<f64>], forward_return: &[Vec<f64>]) -> Result<Vec<f64>> {
    if factor.len() != forward_return.len() {
        return Err(Error::LengthMismatch {
            a: factor.len(),
            b: forward_return.len(),
        });
    }
    let mut out = Vec::with_capacity(factor.len());
    for (f, r) in factor.iter().zip(forward_return) {
        out.push(spearman(f, r)?);
    }
    Ok(out)
}

/// IC Information Ratio = mean(IC series) / stddev(IC series).
/// Higher = more stable factor.
#[must_use]
pub fn ic_ir(ic_series: &[f64]) -> f64 {
    let m = q::mean(ic_series);
    let s = q::stddev(ic_series);
    if s == 0.0 {
        return 0.0;
    }
    m / s
}

/// Annualized Sharpe of a factor-weighted long-short portfolio.
/// `factor_returns`: per-period returns from going long top-quantile / short
/// bottom-quantile. Wraps `fincept_analytics_risk::sharpe`.
#[must_use]
pub fn factor_sharpe(factor_returns: &[f64], periods_per_year: f64) -> f64 {
    fincept_analytics_risk::sharpe(factor_returns, 0.0, periods_per_year)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn approx(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() <= tol, "{a} != {b} (tol {tol})");
    }

    #[test]
    fn pearson_perfect_positive() {
        approx(
            pearson(&[1.0, 2.0, 3.0], &[2.0, 4.0, 6.0]).unwrap(),
            1.0,
            1e-12,
        );
    }

    #[test]
    fn pearson_perfect_negative() {
        approx(
            pearson(&[1.0, 2.0, 3.0], &[3.0, 2.0, 1.0]).unwrap(),
            -1.0,
            1e-12,
        );
    }

    #[test]
    fn spearman_monotone_nonlinear_is_one() {
        // x=[1,2,3], y=x^3 → perfect monotone → Spearman = 1 but Pearson < 1.
        let x: Vec<f64> = vec![1.0, 2.0, 3.0, 4.0];
        let y: Vec<f64> = x.iter().map(|v: &f64| v.powi(3)).collect();
        approx(spearman(&x, &y).unwrap(), 1.0, 1e-12);
    }

    #[test]
    fn rank_ties_are_averaged() {
        // [10, 20, 20, 30] → ranks [1, 2.5, 2.5, 4]
        let r = rank_avg(&[10.0, 20.0, 20.0, 30.0]);
        approx(r[0], 1.0, 1e-12);
        approx(r[1], 2.5, 1e-12);
        approx(r[2], 2.5, 1e-12);
        approx(r[3], 4.0, 1e-12);
    }
}
