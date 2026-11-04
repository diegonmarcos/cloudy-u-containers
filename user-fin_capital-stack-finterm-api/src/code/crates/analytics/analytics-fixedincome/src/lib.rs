//! Fixed-income analytics.
//!
//! All functions use `freq` (compounding frequency per year: 1=annual,
//! 2=semiannual, 4=quarterly) and treat `years` as years to maturity.
//! `coupon_rate` is the annual nominal coupon rate (e.g. 0.06 for 6%).

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("invalid input: {0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Price of a fixed-coupon bond with face 100.
/// price = Σ C/(1+y/f)^i + F/(1+y/f)^n
pub fn bond_price(face: f64, coupon_rate: f64, ytm: f64, years: f64, freq: u32) -> Result<f64> {
    if face <= 0.0 || freq == 0 {
        return Err(Error::Invalid("face>0, freq>=1".into()));
    }
    let periods = (years * freq as f64).round() as i32;
    if periods < 1 {
        return Err(Error::Invalid("periods must be >= 1".into()));
    }
    let c = face * coupon_rate / freq as f64;
    let y = ytm / freq as f64;
    let mut p = 0.0;
    for i in 1..=periods {
        p += c / (1.0 + y).powi(i);
    }
    p += face / (1.0 + y).powi(periods);
    Ok(p)
}

/// Macaulay duration (in years).
/// D = Σ t_i * PV(cf_i) / price, where t_i is time in years.
pub fn macaulay_duration(
    face: f64,
    coupon_rate: f64,
    ytm: f64,
    years: f64,
    freq: u32,
) -> Result<f64> {
    let price = bond_price(face, coupon_rate, ytm, years, freq)?;
    if price == 0.0 {
        return Err(Error::Invalid("price is zero".into()));
    }
    let periods = (years * freq as f64).round() as i32;
    let c = face * coupon_rate / freq as f64;
    let y = ytm / freq as f64;
    let mut weighted = 0.0;
    for i in 1..=periods {
        let t_years = i as f64 / freq as f64;
        let mut pv = c / (1.0 + y).powi(i);
        if i == periods {
            pv += face / (1.0 + y).powi(i);
        }
        weighted += t_years * pv;
    }
    Ok(weighted / price)
}

/// Modified duration = Macaulay / (1 + y/f).
pub fn modified_duration(
    face: f64,
    coupon_rate: f64,
    ytm: f64,
    years: f64,
    freq: u32,
) -> Result<f64> {
    let mac = macaulay_duration(face, coupon_rate, ytm, years, freq)?;
    Ok(mac / (1.0 + ytm / freq as f64))
}

/// Convexity of a fixed-coupon bond.
/// C = (1/price) * Σ t²*(t + 1/f)  ... here we use the standard definition:
///     C = Σ t_i*(t_i + dt) * PV(cf_i) / price, where dt = 1/f (period length
///     in years). This is the Fabozzi/CFA form.
pub fn convexity(face: f64, coupon_rate: f64, ytm: f64, years: f64, freq: u32) -> Result<f64> {
    let price = bond_price(face, coupon_rate, ytm, years, freq)?;
    if price == 0.0 {
        return Err(Error::Invalid("price is zero".into()));
    }
    let periods = (years * freq as f64).round() as i32;
    let c = face * coupon_rate / freq as f64;
    let y = ytm / freq as f64;
    let dt = 1.0 / freq as f64;
    let mut sum = 0.0;
    for i in 1..=periods {
        let t_years = i as f64 / freq as f64;
        let mut pv = c / (1.0 + y).powi(i);
        if i == periods {
            pv += face / (1.0 + y).powi(i);
        }
        sum += t_years * (t_years + dt) * pv;
    }
    Ok(sum / (price * (1.0 + y).powi(2)))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn approx(a: f64, b: f64, tol: f64) {
        assert!((a - b).abs() <= tol, "{a} != {b} (tol {tol})");
    }

    /// Par bond: YTM == coupon rate → price == face.
    #[test]
    fn par_bond_prices_to_face() {
        approx(bond_price(100.0, 0.05, 0.05, 10.0, 2).unwrap(), 100.0, 1e-9);
    }

    /// Discount bond example (CFA textbook):
    /// face=1000, coupon 5% semiannual, YTM 6%, 10y → price ≈ 925.61.
    #[test]
    fn discount_bond() {
        approx(
            bond_price(1000.0, 0.05, 0.06, 10.0, 2).unwrap(),
            925.6133,
            1e-3,
        );
    }

    #[test]
    fn duration_of_zero_coupon_equals_maturity() {
        // D for zero-coupon ≈ maturity (years).
        let mac = macaulay_duration(1000.0, 0.0, 0.05, 10.0, 1).unwrap();
        approx(mac, 10.0, 1e-9);
    }
}
