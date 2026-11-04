//! Foundational ML primitives for the quant lab.
//!
//! Phase 5a: OLS via normal equations (closed-form), column-wise standardize,
//! row-stratified train/test split. All with `ndarray` — no heavyweight ML
//! deps. Phase 5b will layer `candle` on top for ONNX model inference without
//! changing the public surface established here.

use ndarray::{Array1, Array2};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("shape mismatch: X has {x_rows} rows, y has {y_len}")]
    ShapeMismatch { x_rows: usize, y_len: usize },
    #[error("singular matrix — X'X not invertible")]
    Singular,
    #[error("not enough samples ({n}) to split")]
    TooFewSamples { n: usize },
    #[error("ratio must be in (0,1), got {0}")]
    BadRatio(f64),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Ordinary least squares via normal equations: β = (XᵀX)⁻¹ Xᵀy.
///
/// Returns the coefficient vector. Caller prepends a 1-column to X if an
/// intercept is desired (kept explicit — no surprises).
pub fn ols_fit(x: &Array2<f64>, y: &Array1<f64>) -> Result<Array1<f64>> {
    if x.nrows() != y.len() {
        return Err(Error::ShapeMismatch {
            x_rows: x.nrows(),
            y_len: y.len(),
        });
    }
    let xtx = x.t().dot(x);
    let xty = x.t().dot(y);
    let inv = invert_symmetric(&xtx)?;
    Ok(inv.dot(&xty))
}

/// In-place z-score standardization: each column → (x − μ) / σ (sample std).
/// Returns the per-column (mean, stddev) pairs so the caller can inverse-transform.
pub fn standardize(x: &mut Array2<f64>) -> Vec<(f64, f64)> {
    let n = x.nrows() as f64;
    let mut stats = Vec::with_capacity(x.ncols());
    for mut col in x.columns_mut() {
        let mean = col.sum() / n;
        let var = col.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (n - 1.0).max(1.0);
        let sd = var.sqrt();
        if sd > 0.0 {
            col.mapv_inplace(|v| (v - mean) / sd);
        } else {
            col.mapv_inplace(|_| 0.0);
        }
        stats.push((mean, sd));
    }
    stats
}

/// Deterministic ordered split: first `⌊n * train_ratio⌋` rows → train,
/// rest → test. Time-series friendly (preserves order). Returns
/// `((x_train, y_train), (x_test, y_test))`.
#[allow(clippy::type_complexity)]
pub fn train_test_split(
    x: &Array2<f64>,
    y: &Array1<f64>,
    train_ratio: f64,
) -> Result<((Array2<f64>, Array1<f64>), (Array2<f64>, Array1<f64>))> {
    let n = x.nrows();
    if n < 2 {
        return Err(Error::TooFewSamples { n });
    }
    if !(0.0..1.0).contains(&train_ratio) || train_ratio == 0.0 {
        return Err(Error::BadRatio(train_ratio));
    }
    let k = ((n as f64) * train_ratio).floor() as usize;
    let k = k.clamp(1, n - 1);
    Ok((
        (
            x.slice(ndarray::s![..k, ..]).to_owned(),
            y.slice(ndarray::s![..k]).to_owned(),
        ),
        (
            x.slice(ndarray::s![k.., ..]).to_owned(),
            y.slice(ndarray::s![k..]).to_owned(),
        ),
    ))
}

/// Invert a symmetric positive-definite matrix via Gauss-Jordan on
/// the augmented [A | I]. Panics only on caller-facing programmer error —
/// returns `Error::Singular` for numerically singular A.
fn invert_symmetric(a: &Array2<f64>) -> Result<Array2<f64>> {
    let n = a.nrows();
    if n == 0 || a.ncols() != n {
        return Err(Error::Singular);
    }
    let mut aug = Array2::<f64>::zeros((n, 2 * n));
    for i in 0..n {
        for j in 0..n {
            aug[[i, j]] = a[[i, j]];
        }
        aug[[i, n + i]] = 1.0;
    }
    for i in 0..n {
        // Partial pivot on column i
        let mut pivot = i;
        let mut best = aug[[i, i]].abs();
        for r in (i + 1)..n {
            if aug[[r, i]].abs() > best {
                best = aug[[r, i]].abs();
                pivot = r;
            }
        }
        if best < 1e-14 {
            return Err(Error::Singular);
        }
        if pivot != i {
            for c in 0..(2 * n) {
                let tmp = aug[[i, c]];
                aug[[i, c]] = aug[[pivot, c]];
                aug[[pivot, c]] = tmp;
            }
        }
        let piv = aug[[i, i]];
        for c in 0..(2 * n) {
            aug[[i, c]] /= piv;
        }
        for r in 0..n {
            if r == i {
                continue;
            }
            let factor = aug[[r, i]];
            for c in 0..(2 * n) {
                aug[[r, c]] -= factor * aug[[i, c]];
            }
        }
    }
    let mut inv = Array2::<f64>::zeros((n, n));
    for i in 0..n {
        for j in 0..n {
            inv[[i, j]] = aug[[i, n + j]];
        }
    }
    Ok(inv)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ndarray::{array, Array2};

    fn approx(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() <= tol, "{a} != {b} (tol {tol})");
    }

    #[test]
    fn ols_recovers_line() {
        // y = 2x + 3, with intercept column.
        let x: Array2<f64> = array![[1., 0.], [1., 1.], [1., 2.], [1., 3.]];
        let y: Array1<f64> = array![3., 5., 7., 9.];
        let beta = ols_fit(&x, &y).unwrap();
        approx(beta[0], 3.0, 1e-10); // intercept
        approx(beta[1], 2.0, 1e-10); // slope
    }

    #[test]
    fn ols_two_features() {
        // y = 1 + 2x1 + 3x2 over 5 linearly independent points.
        let x: Array2<f64> = array![
            [1., 0., 0.],
            [1., 1., 0.],
            [1., 0., 1.],
            [1., 1., 1.],
            [1., 2., 1.]
        ];
        let y: Array1<f64> = array![1., 3., 4., 6., 8.];
        let beta = ols_fit(&x, &y).unwrap();
        approx(beta[0], 1.0, 1e-10);
        approx(beta[1], 2.0, 1e-10);
        approx(beta[2], 3.0, 1e-10);
    }

    #[test]
    fn standardize_gives_zero_mean() {
        let mut x: Array2<f64> = array![[1., 10.], [2., 20.], [3., 30.], [4., 40.]];
        let _stats = standardize(&mut x);
        for col in x.columns() {
            approx(col.sum() / col.len() as f64, 0.0, 1e-12);
        }
    }

    #[test]
    fn train_test_split_sizes() {
        let x: Array2<f64> = Array2::zeros((10, 3));
        let y: Array1<f64> = Array1::zeros(10);
        let ((xt, yt), (xv, yv)) = train_test_split(&x, &y, 0.7).unwrap();
        assert_eq!(xt.nrows(), 7);
        assert_eq!(yt.len(), 7);
        assert_eq!(xv.nrows(), 3);
        assert_eq!(yv.len(), 3);
    }
}
