//! CFA valuation primitives. Textbook definitions — verifiable against
//! standard financial calculators.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("empty cashflow series")]
    Empty,
    #[error("IRR did not converge within {0} iterations")]
    NotConverged(u32),
    #[error("invalid input: {0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Net Present Value given a per-period rate and a stream of cashflows.
/// Cashflows[0] is treated as time 0 (no discount).
#[must_use]
pub fn npv(rate: f64, cashflows: &[f64]) -> f64 {
    cashflows
        .iter()
        .enumerate()
        .map(|(t, cf)| cf / (1.0 + rate).powi(t as i32))
        .sum()
}

/// Internal Rate of Return via Newton-Raphson. Returns the rate r for which
/// NPV(r)=0. `guess` seeds iteration; default 0.1 is a good generic start.
pub fn irr(cashflows: &[f64], guess: f64) -> Result<f64> {
    if cashflows.len() < 2 {
        return Err(Error::Empty);
    }
    const MAX_ITER: u32 = 200;
    const TOL: f64 = 1e-10;
    let mut r = guess;
    for _ in 0..MAX_ITER {
        let f: f64 = cashflows
            .iter()
            .enumerate()
            .map(|(t, cf)| cf / (1.0 + r).powi(t as i32))
            .sum();
        // derivative: -Σ t*cf / (1+r)^(t+1)
        let fp: f64 = cashflows
            .iter()
            .enumerate()
            .skip(1)
            .map(|(t, cf)| -(t as f64) * cf / (1.0 + r).powi(t as i32 + 1))
            .sum();
        if fp.abs() < 1e-15 {
            break;
        }
        let r_new = r - f / fp;
        if (r_new - r).abs() < TOL {
            return Ok(r_new);
        }
        r = r_new;
    }
    Err(Error::NotConverged(MAX_ITER))
}

/// Future Value of a present sum. FV = PV * (1+r)^n.
#[must_use]
pub fn fv(pv: f64, rate: f64, periods: u32) -> f64 {
    pv * (1.0 + rate).powi(periods as i32)
}

/// Present Value of a future sum. PV = FV / (1+r)^n.
#[must_use]
pub fn pv(fv: f64, rate: f64, periods: u32) -> f64 {
    fv / (1.0 + rate).powi(periods as i32)
}

/// Weighted Average Cost of Capital.
/// WACC = (E/V)*Re + (D/V)*Rd*(1 - Tc)
pub fn wacc(
    equity: f64,
    debt: f64,
    cost_equity: f64,
    cost_debt: f64,
    tax_rate: f64,
) -> Result<f64> {
    let v = equity + debt;
    if v <= 0.0 {
        return Err(Error::Invalid("equity + debt must be positive".into()));
    }
    Ok((equity / v) * cost_equity + (debt / v) * cost_debt * (1.0 - tax_rate))
}

/// Discounted Cash Flow equity valuation: PV of explicit FCF stream plus
/// terminal value via Gordon growth.
///   DCF = Σ FCFᵢ / (1+r)^i + TV / (1+r)^n
///   TV  = FCF_{n+1} / (r - g)
pub fn dcf(fcf: &[f64], discount: f64, terminal_growth: f64) -> Result<f64> {
    if fcf.is_empty() {
        return Err(Error::Empty);
    }
    if discount <= terminal_growth {
        return Err(Error::Invalid(
            "discount must exceed terminal growth".into(),
        ));
    }
    let n = fcf.len();
    let pv_explicit: f64 = fcf
        .iter()
        .enumerate()
        .map(|(i, c)| c / (1.0 + discount).powi(i as i32 + 1))
        .sum();
    let fcf_next = fcf[n - 1] * (1.0 + terminal_growth);
    let tv = fcf_next / (discount - terminal_growth);
    let pv_tv = tv / (1.0 + discount).powi(n as i32);
    Ok(pv_explicit + pv_tv)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() <= tol, "{a} != {b} (tol {tol})");
    }

    #[test]
    fn npv_textbook() {
        // CF = [-1000, 300, 400, 500] at r=0.1 → -21.0368...
        //   = -1000 + 300/1.1 + 400/1.21 + 500/1.331
        approx(npv(0.1, &[-1000.0, 300.0, 400.0, 500.0]), -21.0368144, 1e-5);
    }

    #[test]
    fn irr_textbook() {
        // Same CF. Real IRR ≈ 8.8963% (NPV=0 rate).
        let r = irr(&[-1000.0, 300.0, 400.0, 500.0], 0.1).unwrap();
        approx(r, 0.08896339, 1e-6);
    }

    #[test]
    fn fv_pv_round_trip() {
        let pv_ = 1000.0;
        let f = fv(pv_, 0.05, 10);
        let back = pv(f, 0.05, 10);
        approx(back, pv_, 1e-9);
    }
}
