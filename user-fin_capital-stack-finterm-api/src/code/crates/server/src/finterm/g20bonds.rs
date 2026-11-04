//! G20 Sovereign 10Y Bonds (#1397, /v1/bonds/g20-real): the pure maths. Yields in %; a yield series mixes daily (YYYY-MM-DD) and
//! monthly (YYYY-MM, OECD) points, oldest first; FX is local currency per USD, daily. G20Bonds.kt (APK) and g20bonds.ts (web) are the
//! same maths for their direct-fetch fallback, tested on the same fixture. Every empty cell carries its reason in `null_reason`.

use super::store::window_avg;
use chrono::{Duration as Days, NaiveDate};
use serde_json::{json, Map, Value};

/// The 30-day moving average ending at `end`: the daily points in the window when there are at least `min_daily`, else the monthly
/// average of the month the window centres on (or up to two months before it); None when neither exists. Second: the basis.
pub fn ma(s: &[(String, f64)], end: NaiveDate, win: i64, min_daily: usize) -> Option<(f64, String)> {
    let a = (end - Days::days(win - 1)).to_string();
    let b = end.to_string();
    let d: Vec<f64> = s.iter().filter(|(k, _)| k.len() == 10 && *k >= a && *k <= b).map(|x| x.1).collect();
    if !d.is_empty() && d.len() >= min_daily {
        return Some((d.iter().sum::<f64>() / d.len() as f64, "daily".into()));
    }
    let mid = end - Days::days(win / 2);
    let hi = mid.to_string()[..7].to_string();
    let lo = (mid - Days::days(62)).to_string()[..7].to_string();
    let m = s.iter().filter(|(k, _)| k.len() == 7 && *k <= hi && *k >= lo).max_by(|x, y| x.0.cmp(&y.0))?;
    Some((m.1, format!("monthly {}", m.0)))
}

/// Local currency depreciation vs USD over `years`, annualised, in %: (today / past)^(1/years) - 1.
pub fn dep(today: f64, past: f64, years: i32) -> f64 {
    ((today / past).powf(1.0 / years as f64) - 1.0) * 100.0
}

/// Net USD yield: nominal minus the FX depreciation.
pub fn net(y: f64, fx: f64) -> f64 {
    y - fx
}

/// Real net USD return: net minus US CPI.
pub fn real(net: f64, cpi: f64) -> f64 {
    net - cpi
}

/// Trailing 12-month CPI change in % from a monthly index (dates YYYY-MM-DD or YYYY-MM): the last point over the same month a year before.
pub fn cpi_yoy(s: &[(String, f64)]) -> Option<(f64, String)> {
    let (d, v) = s.iter().max_by(|x, y| x.0.cmp(&y.0))?;
    let y: i32 = d.get(..4)?.parse().ok()?;
    let k = format!("{}{}", y - 1, &d[4..]);
    let v0 = s.iter().find(|(x, _)| *x == k)?.1;
    Some(((v / v0 - 1.0) * 100.0, d[..7.min(d.len())].to_string()))
}

pub const KEYS: [&str; 10] = ["y0", "y1", "y3", "fx1", "fx3", "net1", "net3", "cpi", "real1", "real3"];

/// One country row in the route's shape; every empty cell carries its reason in null_reason, every monthly yield its basis.
pub fn row(r: &Value, y: &[(String, f64)], fx: &[(String, f64)], cpi: Option<&(f64, String)>, end: NaiveDate, win: i64, min_daily: usize) -> Value {
    let mut why = Map::new();
    let mut basis = Map::new();
    let mut o = Map::new();
    for k in ["cc", "ccy", "flag", "name", "bench", "seg"] {
        o.insert(k.into(), json!(r[k].as_str().unwrap_or_default()));
    }
    let mut v: Map<String, Value> = Map::new();
    let put = |v: &mut Map<String, Value>, k: &str, x: Option<f64>| {
        v.insert(k.into(), x.map_or(Value::Null, |x| json!(x)));
        x
    };
    let mut ys = [None; 3];
    for (i, (k, n)) in [("y0", 0i64), ("y1", 1), ("y3", 3)].into_iter().enumerate() {
        let at = end - Days::days(365 * n);
        let m = ma(y, at, win, min_daily);
        ys[i] = put(&mut v, k, m.as_ref().map(|m| m.0));
        match m {
            None => {
                why.insert(k.into(), json!(format!("no 10Y yield (daily or OECD monthly) around {at}")));
            }
            Some((_, b)) if b != "daily" => {
                basis.insert(k.into(), json!(b));
            }
            _ => {}
        }
    }
    let ccy = r["ccy"].as_str().unwrap_or_default();
    let mut fxs = [None; 2];
    if ccy == "USD" {
        fxs = [put(&mut v, "fx1", Some(0.0)), put(&mut v, "fx3", Some(0.0))];
    } else {
        let f0 = window_avg(fx, end, win);
        for (i, (k, n)) in [("fx1", 1i32), ("fx3", 3)].into_iter().enumerate() {
            let p = window_avg(fx, end - Days::days(365 * n as i64), win);
            fxs[i] = put(&mut v, k, f0.zip(p).map(|(a, b)| dep(a, b, n)));
            if fxs[i].is_none() {
                let w = if fx.is_empty() {
                    r["no_fx"].as_str().filter(|s| !s.is_empty()).map_or(format!("no daily USD rate for {ccy}"), str::to_string)
                } else if f0.is_none() {
                    format!("no {ccy} rate in the last {win} days")
                } else {
                    format!("less than {n}y of daily {ccy} history")
                };
                why.insert(k.into(), json!(w));
            }
        }
    }
    let c = put(&mut v, "cpi", cpi.map(|c| c.0));
    match cpi {
        None => {
            why.insert("cpi".into(), json!("no US CPI (FRED CPIAUCSL) a year apart"));
        }
        Some((_, m)) => {
            o.insert("cpi_month".into(), json!(m));
        }
    }
    for (i, n) in [1, 3].into_iter().enumerate() {
        let ne = put(&mut v, &format!("net{n}"), ys[0].zip(fxs[i]).map(|(a, b)| net(a, b)));
        if ne.is_none() {
            why.insert(format!("net{n}"), json!(format!("needs the 10Y yield today and the {n}Y FX change")));
        }
        if put(&mut v, &format!("real{n}"), ne.zip(c).map(|(a, b)| real(a, b))).is_none() {
            why.insert(format!("real{n}"), json!(format!("needs the {n}Y net USD yield and US CPI")));
        }
    }
    o.extend(v);
    o.insert("basis".into(), Value::Object(basis));
    o.insert("null_reason".into(), Value::Object(why));
    o.insert("as_of".into(), json!(end.to_string()));
    Value::Object(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[(&str, f64)]) -> Vec<(String, f64)> {
        v.iter().map(|(a, b)| (a.to_string(), *b)).collect()
    }

    // the same fixture as TablesTest.g20BondsMovingAverageFxAnnualisationNetAndReal (APK) and g20bonds.test.ts (web)
    #[test]
    fn moving_average_fx_annualisation_net_and_real() {
        let end = NaiveDate::from_ymd_opt(2026, 10, 30).unwrap();
        let y = s(&[("2023-09", 3.5), ("2023-11", 9.9), ("2025-10", 3.9), ("2026-09", 4.1), ("2026-10-10", 4.0), ("2026-10-20", 4.2), ("2026-10-30", 4.4)]);
        let fx = s(&[("2023-10-31", 4.0), ("2025-10-30", 5.0), ("2026-10-30", 6.0)]);
        let cpi = cpi_yoy(&s(&[("2025-09-01", 100.0), ("2026-09-01", 103.0)])).unwrap();
        assert!((cpi.0 - 3.0).abs() < 1e-12 && cpi.1 == "2026-09");
        let d0 = ma(&y, end, 30, 3).unwrap();
        assert!((d0.0 - 4.2).abs() < 1e-12 && d0.1 == "daily");
        assert_eq!(ma(&y, end, 30, 4), Some((4.1, "monthly 2026-09".into())));
        assert_eq!(ma(&y, end - Days::days(1095), 30, 3), Some((3.5, "monthly 2023-09".into())));
        assert_eq!(ma(&y, NaiveDate::from_ymd_opt(2020, 1, 1).unwrap(), 30, 3), None);
        assert!((dep(6.0, 5.0, 1) - 20.0).abs() < 1e-12);
        let f3 = (1.5f64.cbrt() - 1.0) * 100.0;
        assert!((dep(6.0, 4.0, 3) - f3).abs() < 1e-12);
        let r = row(&json!({"cc":"XX","ccy":"XXX","flag":"F","name":"Testland","bench":"TB"}), &y, &fx, Some(&cpi), end, 30, 3);
        let g = |k: &str| r[k].as_f64().unwrap();
        for (k, want) in [("y0", 4.2), ("y1", 3.9), ("y3", 3.5), ("fx1", 20.0), ("fx3", f3), ("net1", 4.2 - 20.0), ("net3", 4.2 - f3), ("real1", 4.2 - 20.0 - 3.0), ("real3", 4.2 - f3 - 3.0)] {
            assert!((g(k) - want).abs() < 1e-12, "{k}: {} want {want}", g(k));
        }
        assert_eq!(r["basis"]["y1"], "monthly 2025-10");
        assert!(r["basis"].get("y0").is_none(), "a daily MA30 carries no basis");
        // the window is the 30 days ending at `end`: day end-29 is in, day end-30 is out
        assert_eq!(ma(&s(&[("2026-10-01", 5.0)]), end, 30, 1), Some((5.0, "daily".into())));
        assert_eq!(ma(&s(&[("2026-09-30", 5.0)]), end, 30, 1), None);
        // the monthly fallback is the month the window centres on (end - 15 days), not the month of `end`
        let nov = NaiveDate::from_ymd_opt(2026, 11, 10).unwrap();
        assert_eq!(ma(&s(&[("2026-10", 6.0), ("2026-11", 7.0)]), nov, 30, 1), Some((6.0, "monthly 2026-10".into())));
        assert_eq!(r["null_reason"], json!({}));
        let us = row(&json!({"cc":"US","ccy":"USD"}), &y, &[], Some(&cpi), end, 30, 3);
        assert_eq!(us["fx3"].as_f64(), Some(0.0));
        assert!((us["real1"].as_f64().unwrap() - 1.2).abs() < 1e-12);
        let ru = row(&json!({"cc":"RU","ccy":"RUB","no_fx":"no rate"}), &[], &[], None, end, 30, 3);
        let w = &ru["null_reason"];
        assert_eq!(w["fx1"], "no rate");
        assert!(w["y0"].as_str().unwrap().starts_with("no 10Y yield") && w.get("cpi").is_some() && w.get("real3").is_some() && ru["net1"].is_null());
    }
}
