//! G20 FX & PPP Matrix (#1396, /v1/fx/ppp-matrix): the pure maths. Rates are local currency per USD (LCU/USD); series are
//! (date or year, value), oldest first. FxMatrix.kt (APK) and fxmatrix.ts (web) are the same maths for their direct-fetch fallback,
//! tested on the same fixture. Every empty cell carries its reason in `null_reason`.

use super::store::{fx_ppp_row, window_avg};
use chrono::{Duration as Days, NaiveDate};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

/// RPPP: a historical rate in today's prices, S_hist * (1 + pi_dom) / (1 + pi_US), pi the cumulative CPI growth over the window.
pub fn rppp(s_hist: f64, home0: f64, home1: f64, us0: f64, us1: f64) -> f64 {
    s_hist * (home1 / home0) / (us1 / us0)
}

/// The ICE dollar index from LCU/USD legs: constant * prod(rate ^ weight)
/// (= 50.14348112 * EURUSD^-0.576 * USDJPY^0.136 * GBPUSD^-0.119 * USDCAD^0.091 * USDSEK^0.042 * USDCHF^0.036).
pub fn dxy(constant: f64, legs: &[(f64, f64)]) -> f64 {
    legs.iter().fold(constant, |acc, (w, x)| acc * x.powf(*w))
}

/// Today / x - 1, in percent.
pub fn diff(today: f64, x: f64) -> f64 {
    (today / x - 1.0) * 100.0
}

pub fn ma_key(years: i64) -> String {
    format!("ma_{years}y")
}

/// The value columns, in order: the real 30MA at each lag, macro PPP, retail (Big Mac) PPP.
pub fn keys(lags: &[i64]) -> Vec<String> {
    let mut k: Vec<String> = lags.iter().map(|y| ma_key(*y)).collect();
    k.push("macro_ppp".into());
    k.push("retail_ppp".into());
    k
}

fn at_year(s: &[(String, f64)], y: i64) -> Option<f64> {
    s.iter().find(|(d, _)| d.as_str() == y.to_string()).map(|x| x.1)
}

fn last_year(s: &[(String, f64)]) -> Option<i64> {
    s.last().and_then(|x| x.0.get(0..4)?.parse::<i64>().ok())
}

fn diffs(o: &mut Map<String, Value>, lags: &[i64]) {
    let t = o.get("today").and_then(Value::as_f64);
    for k in keys(lags) {
        let x = o.get(&k).and_then(Value::as_f64);
        o.insert(format!("diff_{k}"), json!(t.zip(x).map(|(t, x)| diff(t, x))));
    }
}

/// One currency row: today, the real 30MA at each lag, macro PPP, Big Mac PPP and the four diffs.
#[allow(clippy::too_many_arguments)]
pub fn row(r: &Value, fx: &[(String, f64)], ppp: &[(String, f64)], cpi: &[(String, f64)], us_cpi: &[(String, f64)], bm: &[(String, f64)], bm_us: &[(String, f64)], win: i64, lags: &[i64]) -> Value {
    let mut why = Map::new();
    let ccy = r["ccy"].as_str().unwrap_or_default();
    let mut o = Map::new();
    for k in ["ccy", "cc", "seg", "label"] {
        o.insert(k.into(), r.get(k).cloned().unwrap_or(json!("")));
    }
    let today = fx.last().cloned();
    if today.is_none() {
        why.insert("today".into(), json!(r["no_fx"].as_str().unwrap_or("no free official daily USD rate for this currency")));
    }
    let end = today.as_ref().and_then(|t| NaiveDate::parse_from_str(&t.0, "%Y-%m-%d").ok());
    let y1 = last_year(cpi).zip(last_year(us_cpi)).map(|(a, b)| a.min(b));
    for k in lags {
        let key = ma_key(*k);
        let raw = end.and_then(|e| window_avg(fx, e - Days::days(365 * k), win));
        if today.is_some() && raw.is_none() {
            why.insert(key.clone(), json!(format!("less than {k}y of daily FX history")));
        }
        let mut adj = None;
        if let Some(raw) = raw {
            let v = y1.and_then(|y| Some((at_year(cpi, y - k)?, at_year(cpi, y)?, at_year(us_cpi, y - k)?, at_year(us_cpi, y)?)));
            match v {
                Some((h0, h1, u0, u1)) => adj = Some(rppp(raw, h0, h1, u0, u1)),
                None => {
                    let ys = y1.map_or(("?".to_string(), "?".to_string()), |y| ((y - k).to_string(), y.to_string()));
                    why.insert(key.clone(), json!(format!("no World Bank CPI (FP.CPI.TOTL) for {} and {} on both sides", ys.0, ys.1)));
                }
            }
        }
        o.insert(key.clone(), json!(adj));
        o.insert(format!("{key}_raw"), json!(raw));
    }
    let p = fx_ppp_row(r, fx, ppp, cpi, us_cpi, win);
    let macro_ppp = p["ppp"].as_f64();
    if macro_ppp.is_none() {
        why.insert("macro_ppp".into(), json!(p["null_reason"]["ppp"].as_str().unwrap_or("no World Bank PPP")));
    }
    o.insert("macro_ppp".into(), json!(macro_ppp));
    let mut retail = None;
    match bm_us.last() {
        None => {
            why.insert("retail_ppp".into(), json!("no US Big Mac price in The Economist's data"));
        }
        Some((d, us)) => match bm.iter().find(|x| &x.0 == d) {
            Some((_, local)) => {
                retail = Some(local / us);
                o.insert("bigmac_date".into(), json!(d));
            }
            None => {
                let msg = match bm.last() {
                    None => format!("The Economist's Big Mac index does not cover {ccy}"),
                    Some((l, _)) => format!("no {ccy} Big Mac price in the {d} survey (last {l})"),
                };
                why.insert("retail_ppp".into(), json!(msg));
            }
        },
    }
    o.insert("retail_ppp".into(), json!(retail));
    o.insert("today".into(), json!(today.as_ref().map(|t| t.1)));
    o.insert("today_date".into(), json!(today.as_ref().map(|t| t.0.clone())));
    o.insert("cpi_year".into(), json!(y1));
    if r["market_quote"].as_bool() == Some(true) {
        o.insert("market_quote".into(), json!(today.as_ref().map(|t| 1.0 / t.1)));
    }
    diffs(&mut o, lags);
    o.insert("null_reason".into(), Value::Object(why));
    Value::Object(o)
}

/// The DXY row: each column is the index of the legs' values in that column; a missing leg names itself (and its own reason).
pub fn dxy_row(d: &Value, by_ccy: &HashMap<String, Value>, lags: &[i64]) -> Value {
    let mut why = Map::new();
    let c = d["constant"].as_f64().unwrap_or(f64::NAN);
    let legs = d["legs"].as_array().cloned().unwrap_or_default();
    let mut o = Map::new();
    o.insert("ccy".into(), json!("DXY"));
    o.insert("seg".into(), json!("Index"));
    o.insert("label".into(), d.get("label").cloned().unwrap_or(json!("")));
    let mut cols = vec!["today".to_string()];
    cols.extend(keys(lags));
    for k in cols {
        let mut v = Vec::new();
        let mut miss = None;
        for l in &legs {
            let ccy = l["ccy"].as_str().unwrap_or_default();
            match by_ccy.get(ccy).and_then(|r| r[&k].as_f64()) {
                Some(x) => v.push((l["weight"].as_f64().unwrap_or(f64::NAN), x)),
                None => {
                    miss = Some(ccy.to_string());
                    break;
                }
            }
        }
        match miss {
            Some(ccy) => {
                let leg = by_ccy.get(&ccy).and_then(|r| r["null_reason"][&k].as_str()).unwrap_or_default();
                why.insert(k.clone(), json!(if leg.is_empty() { format!("needs the {ccy} leg") } else { format!("needs the {ccy} leg ({leg})") }));
                o.insert(k, Value::Null);
            }
            None => {
                o.insert(k, json!(dxy(c, &v)));
            }
        }
    }
    o.insert("today_date".into(), json!(by_ccy.values().filter_map(|r| r["today_date"].as_str()).max()));
    diffs(&mut o, lags);
    o.insert("null_reason".into(), Value::Object(why));
    Value::Object(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn y(v: &[(i64, f64)]) -> Vec<(String, f64)> {
        v.iter().map(|(a, b)| (a.to_string(), *b)).collect()
    }
    fn s(v: &[(&str, f64)]) -> Vec<(String, f64)> {
        v.iter().map(|(a, b)| (a.to_string(), *b)).collect()
    }
    fn close(a: f64, b: f64, eps: f64) {
        assert!((a - b).abs() < eps, "{a} != {b}");
    }

    // the same fixture as TablesTest.fxMatrixRealMovingAveragesPppBigMacDiffsAndDxy (APK) and fxmatrix.test.ts (web)
    #[test]
    fn real_moving_averages_ppp_big_mac_diffs_and_dxy() {
        close(rppp(7.0, 100.0, 110.0, 200.0, 210.0), 7.0 * 1.10 / 1.05, 1e-12);
        close(dxy(50.14348112, &[(0.576, 1.0), (0.424, 1.0)]), 50.14348112, 1e-12);
        close(dxy(50.14348112, &[(0.6, 0.9), (0.4, 150.0)]), 50.14348112 * 0.9f64.powf(0.6) * 150f64.powf(0.4), 1e-9);
        close(diff(7.2, 6.0), 20.0, 1e-12);
        let fx = s(&[("2023-10-15", 6.0), ("2025-10-20", 7.0), ("2026-10-30", 7.2)]);
        let cpi = y(&[(2022, 100.0), (2024, 106.0), (2025, 110.0)]);
        let us = y(&[(2022, 200.0), (2024, 210.0), (2025, 214.0)]);
        let bm = s(&[("2026-01-01", 25.0), ("2026-07-01", 26.5)]);
        let bm_us = s(&[("2026-07-01", 6.22)]);
        let r = row(&json!({"ccy":"CNY","cc":"CN","a3":"CHN","seg":"BRICS","label":"Chinese yuan"}), &fx, &y(&[(2024, 3.5)]), &cpi, &us, &bm, &bm_us, 30, &[1, 3]);
        let ma1 = 7.0 * (110.0 / 106.0) / (214.0 / 210.0);
        let ma3 = 6.0 * (110.0 / 100.0) / (214.0 / 200.0);
        let macro_ppp = 3.5 * (110.0 / 106.0) / (214.0 / 210.0);
        let retail = 26.5 / 6.22;
        close(r["today"].as_f64().unwrap(), 7.2, 1e-12);
        close(r["ma_1y"].as_f64().unwrap(), ma1, 1e-12);
        close(r["ma_3y"].as_f64().unwrap(), ma3, 1e-12);
        close(r["ma_1y_raw"].as_f64().unwrap(), 7.0, 1e-12);
        close(r["macro_ppp"].as_f64().unwrap(), macro_ppp, 1e-12);
        close(r["retail_ppp"].as_f64().unwrap(), retail, 1e-12);
        close(r["diff_ma_1y"].as_f64().unwrap(), (7.2 / ma1 - 1.0) * 100.0, 1e-9);
        close(r["diff_ma_3y"].as_f64().unwrap(), (7.2 / ma3 - 1.0) * 100.0, 1e-9);
        close(r["diff_macro_ppp"].as_f64().unwrap(), (7.2 / macro_ppp - 1.0) * 100.0, 1e-9);
        close(r["diff_retail_ppp"].as_f64().unwrap(), (7.2 / retail - 1.0) * 100.0, 1e-9);
        assert_eq!(r["bigmac_date"], "2026-07-01");
        assert_eq!(r["cpi_year"], 2025);
        assert!(r["null_reason"].as_object().unwrap().is_empty(), "{}", r["null_reason"]);
        assert!(r.get("market_quote").is_none());
        // a currency whose Big Mac series stopped, with no rate: every empty cell says why
        let ru = row(&json!({"ccy":"RUB","cc":"RU","a3":"RUS","no_fx":"no rate"}), &[], &[], &[], &[], &s(&[("2022-01-01", 135.0)]), &bm_us, 30, &[1, 3]);
        let w = &ru["null_reason"];
        assert_eq!(w["today"], "no rate");
        assert!(w["retail_ppp"].as_str().unwrap().contains("last 2022-01-01"));
        assert!(w["macro_ppp"].is_string() && ru["diff_retail_ppp"].is_null() && ru["today"].is_null());
        let none = row(&json!({"ccy":"XXX"}), &fx, &[], &cpi, &us, &[], &bm_us, 30, &[1]);
        assert_eq!(none["null_reason"]["retail_ppp"], "The Economist's Big Mac index does not cover XXX");
        assert!(row(&json!({"ccy":"X"}), &fx, &[], &cpi, &us, &[], &[], 30, &[1])["null_reason"]["retail_ppp"].as_str().unwrap().contains("no US Big Mac"));
        // short history and missing CPI each name themselves
        let short = row(&json!({"ccy":"X"}), &fx[2..], &[], &cpi, &us, &[], &[], 30, &[1]);
        assert_eq!(short["null_reason"]["ma_1y"], "less than 1y of daily FX history");
        let nocpi = row(&json!({"ccy":"X"}), &fx, &[], &y(&[(2025, 110.0)]), &us, &[], &[], 30, &[1]);
        assert_eq!(nocpi["null_reason"]["ma_1y"], "no World Bank CPI (FP.CPI.TOTL) for 2024 and 2025 on both sides");
        assert!(nocpi["ma_1y"].is_null() && nocpi["ma_1y_raw"].as_f64() == Some(7.0));
        // the market quote is 1 / today
        close(row(&json!({"ccy":"EUR","market_quote":true}), &fx, &[], &cpi, &us, &bm, &bm_us, 30, &[1])["market_quote"].as_f64().unwrap(), 1.0 / 7.2, 1e-12);
        // DXY: the index of the legs per column; a missing leg names itself and its reason
        let mut by = HashMap::new();
        by.insert("EUR".to_string(), json!({"ccy":"EUR","today":0.9,"ma_1y":0.95,"today_date":"2026-10-30","null_reason":{}}));
        by.insert("JPY".to_string(), json!({"ccy":"JPY","today":150.0,"today_date":"2026-10-29","null_reason":{"ma_1y":"short"}}));
        let d = dxy_row(&json!({"constant":50.14348112,"label":"DXY","legs":[{"ccy":"EUR","weight":0.6},{"ccy":"JPY","weight":0.4}]}), &by, &[1]);
        close(d["today"].as_f64().unwrap(), 50.14348112 * 0.9f64.powf(0.6) * 150f64.powf(0.4), 1e-9);
        assert_eq!(d["null_reason"]["ma_1y"], "needs the JPY leg (short)");
        assert!(d["ma_1y"].is_null() && d["diff_ma_1y"].is_null());
        assert_eq!(d["today_date"], "2026-10-30");
        assert_eq!(d["ccy"], "DXY");
        by.get_mut("JPY").unwrap()["ma_1y"] = json!(140.0);
        let d2 = dxy_row(&json!({"constant":50.14348112,"legs":[{"ccy":"EUR","weight":0.6},{"ccy":"JPY","weight":0.4}]}), &by, &[1]);
        let m = 50.14348112 * 0.95f64.powf(0.6) * 140f64.powf(0.4);
        close(d2["diff_ma_1y"].as_f64().unwrap(), diff(d2["today"].as_f64().unwrap(), m), 1e-9);
        assert_eq!(d2["null_reason"]["macro_ppp"], "needs the EUR leg");
    }

    #[test]
    fn ice_weights_reproduce_the_published_index() {
        // a weaker euro (more EUR per USD) lifts the index by its weight: 1% -> about 0.576%
        let base = [(0.576, 0.9), (0.136, 150.0), (0.119, 0.75), (0.091, 1.38), (0.042, 9.5), (0.036, 0.8)];
        let mut up = base;
        up[0].1 *= 1.01;
        close(dxy(50.14348112, &up) / dxy(50.14348112, &base), 1.01f64.powf(0.576), 1e-12);
        // the textbook formula in market quotes gives the same number
        let book = 50.14348112 * (1.0 / 0.9f64).powf(-0.576) * 150f64.powf(0.136) * (1.0 / 0.75f64).powf(-0.119) * 1.38f64.powf(0.091) * 9.5f64.powf(0.042) * 0.8f64.powf(0.036);
        close(dxy(50.14348112, &base), book, 1e-9);
    }
}
