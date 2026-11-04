//! Core statistics primitives. Pure functions, no external numeric deps —
//! keeps this crate tiny and verifiable against textbook formulas.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("empty input")]
    Empty,
    #[error("invalid percentile: {0} (expected 0..=100)")]
    InvalidPercentile(f64),
    #[error("mismatched lengths")]
    LengthMismatch,
}

pub type Result<T> = std::result::Result<T, Error>;

#[must_use]
pub fn mean(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    xs.iter().sum::<f64>() / xs.len() as f64
}

/// Sample standard deviation (Bessel-corrected, N-1 denominator).
#[must_use]
pub fn stddev(xs: &[f64]) -> f64 {
    if xs.len() < 2 {
        return 0.0;
    }
    let m = mean(xs);
    let var = xs.iter().map(|x| (x - m).powi(2)).sum::<f64>() / (xs.len() - 1) as f64;
    var.sqrt()
}

/// Population standard deviation (N denominator). Used in skew/kurt.
#[must_use]
pub fn stddev_pop(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    let m = mean(xs);
    (xs.iter().map(|x| (x - m).powi(2)).sum::<f64>() / xs.len() as f64).sqrt()
}

/// Linear-interpolated percentile (type 7 — R/NumPy default).
pub fn percentile(xs: &[f64], p: f64) -> Result<f64> {
    if xs.is_empty() {
        return Err(Error::Empty);
    }
    if !(0.0..=100.0).contains(&p) {
        return Err(Error::InvalidPercentile(p));
    }
    let mut sorted = xs.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let rank = p / 100.0 * (sorted.len() - 1) as f64;
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    if lo == hi {
        Ok(sorted[lo])
    } else {
        let frac = rank - lo as f64;
        Ok(sorted[lo] * (1.0 - frac) + sorted[hi] * frac)
    }
}

/// Population (biased) skewness — matches scipy.stats.skew(bias=True).
#[must_use]
pub fn skewness(xs: &[f64]) -> f64 {
    if xs.len() < 2 {
        return 0.0;
    }
    let m = mean(xs);
    let s = stddev_pop(xs);
    if s == 0.0 {
        return 0.0;
    }
    let n = xs.len() as f64;
    xs.iter().map(|x| ((x - m) / s).powi(3)).sum::<f64>() / n
}

/// Excess kurtosis (biased) — matches scipy.stats.kurtosis(bias=True,
/// fisher=True): returns 0 for normal distribution.
#[must_use]
pub fn kurtosis(xs: &[f64]) -> f64 {
    if xs.len() < 2 {
        return 0.0;
    }
    let m = mean(xs);
    let s = stddev_pop(xs);
    if s == 0.0 {
        return 0.0;
    }
    let n = xs.len() as f64;
    xs.iter().map(|x| ((x - m) / s).powi(4)).sum::<f64>() / n - 3.0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Approximate equality with user-supplied tolerance.
    fn approx(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() <= tol, "{a} != {b} (tol {tol})");
    }

    #[test]
    fn mean_basic() {
        approx(mean(&[1.0, 2.0, 3.0]), 2.0, 1e-12);
    }

    #[test]
    fn stddev_sample() {
        // σ of [1,2,3,4,5] with N-1 denom = sqrt(2.5)
        approx(
            stddev(&[1.0, 2.0, 3.0, 4.0, 5.0]),
            1.5811388300841898,
            1e-12,
        );
    }

    #[test]
    fn percentile_type7() {
        // Median of [1..=5] = 3
        approx(
            percentile(&[1.0, 2.0, 3.0, 4.0, 5.0], 50.0).unwrap(),
            3.0,
            1e-12,
        );
        // 25th of [1..=5] with linear interp = 2
        approx(
            percentile(&[1.0, 2.0, 3.0, 4.0, 5.0], 25.0).unwrap(),
            2.0,
            1e-12,
        );
    }

    #[test]
    fn skewness_symmetric_is_zero() {
        approx(skewness(&[1.0, 2.0, 3.0, 4.0, 5.0]), 0.0, 1e-12);
    }

    #[test]
    fn kurtosis_of_uniform_is_negative() {
        // Excess kurtosis for uniform sample is < 0.
        let v: Vec<f64> = (1..=100).map(|i| i as f64).collect();
        assert!(kurtosis(&v) < 0.0);
    }
}
