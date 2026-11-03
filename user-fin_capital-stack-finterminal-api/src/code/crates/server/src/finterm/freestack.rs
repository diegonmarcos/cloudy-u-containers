//! #1416 the free, non-real-time stack (FRED, OpenFIGI, FMP, SEC EDGAR, Yahoo flagged), declared in fetchers.json
//! `declared["universe.json"].free_stack` (the app's data/universe.json, gen-fetchers.mjs checks it). Pure code only: the parsers of
//! its store formats, the pacing gap, the key / flag state, and the `/v1/sources` rows. The tasks that fetch live in store.rs.
//! No provider address is typed here. A key is read from the fleet secret store (the declared env variable, or `<env>_FILE`) and is
//! never printed: an error that could carry it goes through `redact`.

use super::store::Obs;
use serde_json::{json, Value};
use std::time::Duration;

/// The minimum gap between two requests to one source: 60000 / per_min ms (SEC's 600 a minute = 10 a second = 100 ms).
pub fn gap(per_min: u64) -> Duration {
    Duration::from_millis(60_000 / per_min.max(1))
}

/// The key of a keyed source: `<env>` itself, else the file `<env>_FILE` names (the fleet secret store mounts either), trimmed.
pub fn key(env: &str, var: impl Fn(&str) -> Option<String>, read: impl Fn(&str) -> Option<String>) -> Option<String> {
    let direct = var(env).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    direct.or_else(|| var(&format!("{env}_FILE")).and_then(|p| read(&p)).map(|v| v.trim().to_string()).filter(|v| !v.is_empty()))
}

/// A flag is on only when its env variable is exactly "1" or "true"; anything else, or unset, keeps the declared default.
pub fn flag_on(declared_default: bool, value: Option<&str>) -> bool {
    match value {
        Some("1") | Some("true") => true,
        Some(_) => false,
        None => declared_default,
    }
}

/// ready | needs_key | flag_off.
pub fn state(s: &Value, has_key: bool, flag: bool) -> &'static str {
    if s.get("key").is_some_and(|k| !k.is_null()) && !has_key {
        "needs_key"
    } else if s.get("flag").is_some_and(|f| !f.is_null()) && !flag {
        "flag_off"
    } else {
        "ready"
    }
}

/// Yahoo is the last fallback: asked for a symbol only when its flag is on and no earlier source (cboe, fred, coinbase) holds it.
pub fn yahoo_wanted(flag: bool, primary_has_rows: bool) -> bool {
    flag && !primary_has_rows
}

/// Removes a key from a message before it is logged or stored.
pub fn redact(msg: &str, key: Option<&str>) -> String {
    match key {
        Some(k) if !k.is_empty() => msg.replace(k, "***"),
        _ => msg.to_string(),
    }
}

/// One `/v1/sources` row: what About > Data sources shows (name, coverage, licence / terms, rate, key need, status, reason).
pub fn row(s: &Value, st: &str, last_ok: Option<i64>, error: Option<&str>) -> Value {
    let per_min = s["per_min"].as_u64().unwrap_or(0);
    let rate = if per_min % 60 == 0 && per_min > 0 { format!("{}/s", per_min / 60) } else { format!("{per_min}/min") };
    let rate = match s["per_day"].as_u64() {
        Some(d) => format!("{rate}, {d}/day"),
        None => rate,
    };
    let reason = match st {
        "needs_key" => s.pointer("/key/reason").cloned().unwrap_or(Value::Null),
        "flag_off" => json!(format!("feature flag {} is off; last fallback after {}", s.pointer("/flag/env").and_then(Value::as_str).unwrap_or_default(),
            s.pointer("/flag/after").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default())),
        _ => error.map(|e| json!(e)).unwrap_or(Value::Null),
    };
    json!({
        "id": s["id"], "name": s["name"], "coverage": s["coverage"], "licence": s["licence"], "terms": s["terms"],
        "rate_limit": rate, "key_needed": !s["key"].is_null(), "status": st, "reason": reason, "last_ok": last_ok,
    })
}

fn obs(id: String, date: String, value: f64) -> Obs {
    Obs { id, date, value, ..Default::default() }
}

/// OpenFIGI /v3/mapping: one answer per job, in job order: `{data:[{figi,...}]}` or `{warning|error}`.
pub fn openfigi_map(body: &str, jobs: &[Value]) -> Value {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let answers = v.as_array().cloned().unwrap_or_default();
    let out: Vec<Value> = jobs
        .iter()
        .zip(answers.iter())
        .map(|(j, a)| {
            let q = format!("{}:{}", j["idType"].as_str().unwrap_or_default(), j["idValue"].as_str().unwrap_or_default());
            match a.pointer("/data/0") {
                Some(d) => json!({ "query": q, "figi": d["figi"], "name": d["name"], "ticker": d["ticker"], "exch": d["exchCode"],
                    "sector": d["marketSector"], "type": d["securityType"] }),
                None => json!({ "query": q, "figi": null, "error": a.get("warning").or_else(|| a.get("error")).cloned().unwrap_or(json!("no match")) }),
            }
        })
        .collect();
    Value::Array(out)
}

/// FMP /stable/ratios: `[{symbol, date, <ratio>: number}]`; every finite number becomes `ratio:<SYM>:<field>`.
pub fn fmp_ratios(body: &str, symbol: &str) -> Vec<Obs> {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let mut out = Vec::new();
    for r in v.as_array().map(Vec::as_slice).unwrap_or(&[]) {
        let Some(date) = r["date"].as_str().and_then(|d| d.get(..10)) else { continue };
        for (k, x) in r.as_object().into_iter().flatten() {
            if let Some(n) = x.as_f64() {
                out.push(obs(format!("ratio:{symbol}:{k}"), date.to_string(), n));
            }
        }
    }
    out
}

/// EDGAR submissions: `filings.recent` column arrays; only the declared forms, newest first, at most `keep`.
pub fn sec_filings(body: &str, forms: &[String], keep: usize) -> Value {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let r = &v["filings"]["recent"];
    let col = |k: &str, i: usize| r[k].get(i).and_then(Value::as_str).unwrap_or_default().to_string();
    let n = r["form"].as_array().map(Vec::len).unwrap_or(0);
    let mut rows: Vec<(String, Value)> = (0..n)
        .filter(|&i| forms.iter().any(|f| *f == col("form", i)))
        .map(|i| (col("filingDate", i), json!({ "form": col("form", i), "date": col("filingDate", i), "accession": col("accessionNumber", i), "document": col("primaryDocument", i) })))
        .collect();
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.truncate(keep);
    json!({ "name": v["name"], "filings": rows.into_iter().map(|r| r.1).collect::<Vec<_>>() })
}

/// EDGAR XBRL companyfacts: `facts.us-gaap.<concept>.units.<unit>[{end, val, form}]`, declared concepts and forms only; the last
/// row of a concept and period wins.
pub fn sec_facts(body: &str, cik: &str, concepts: &[String], forms: &[String]) -> Vec<Obs> {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let g = &v["facts"]["us-gaap"];
    let mut out: Vec<Obs> = Vec::new();
    for c in concepts {
        for rows in g[c.as_str()]["units"].as_object().into_iter().flat_map(|u| u.values()) {
            for x in rows.as_array().map(Vec::as_slice).unwrap_or(&[]) {
                let form = x["form"].as_str().unwrap_or_default();
                let (Some(end), Some(val)) = (x["end"].as_str(), x["val"].as_f64()) else { continue };
                if !forms.iter().any(|f| f == form) || end.len() != 10 {
                    continue;
                }
                let id = format!("fact:{cik}:{c}");
                match out.iter_mut().find(|o| o.id == id && o.date == end) {
                    Some(o) => o.value = val,
                    None => out.push(obs(id, end.to_string(), val)),
                }
            }
        }
    }
    out
}

/// Yahoo v8 chart: closes per timestamp (`px:<SYM>`, with open/high/low), `events.dividends` (`div:`), `events.splits`
/// (`split:` = numerator / denominator).
pub fn yahoo_chart(body: &str, symbol: &str) -> Vec<Obs> {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let r = &v["chart"]["result"][0];
    let day = |t: i64| chrono::DateTime::from_timestamp(t, 0).map(|d| d.date_naive().to_string());
    let q = &r["indicators"]["quote"][0];
    let mut out = Vec::new();
    for (i, t) in r["timestamp"].as_array().map(Vec::as_slice).unwrap_or(&[]).iter().enumerate() {
        let (Some(date), Some(c)) = (t.as_i64().and_then(day), q["close"][i].as_f64()) else { continue };
        if c > 0.0 {
            let pos = |k: &str| q[k][i].as_f64().filter(|x| *x > 0.0);
            out.push(Obs { id: format!("px:{symbol}"), date, value: c, o: pos("open"), h: pos("high"), l: pos("low") });
        }
    }
    for d in r["events"]["dividends"].as_object().into_iter().flat_map(|m| m.values()) {
        if let (Some(date), Some(a)) = (d["date"].as_i64().and_then(day), d["amount"].as_f64()) {
            out.push(obs(format!("div:{symbol}"), date, a));
        }
    }
    for s in r["events"]["splits"].as_object().into_iter().flat_map(|m| m.values()) {
        if let (Some(date), Some(n), Some(dd)) = (s["date"].as_i64().and_then(day), s["numerator"].as_f64(), s["denominator"].as_f64()) {
            if dd != 0.0 {
                out.push(obs(format!("split:{symbol}"), date, n / dd));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fs() -> Value {
        let doc: Value = serde_json::from_str(super::super::FETCHERS_JSON).unwrap();
        doc["declared"]["universe.json"]["free_stack"].clone()
    }
    fn src(id: &str) -> Value {
        fs()["sources"].as_array().unwrap().iter().find(|s| s["id"] == id).unwrap().clone()
    }

    #[test]
    fn the_declaration_holds_five_sources_whose_formats_the_store_parses() {
        let ids: Vec<String> = fs()["sources"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, ["fred", "openfigi", "fmp", "sec_edgar", "yahoo"]);
        for s in fs()["sources"].as_array().unwrap() {
            let formats: Vec<String> = match s["formats"].as_object() {
                Some(m) => m.keys().cloned().collect(),
                None => vec![s["format"].as_str().unwrap().to_string()],
            };
            for f in formats {
                assert!(super::super::store::STORE_FORMATS.contains(&f.as_str()), "{f}");
            }
        }
    }

    #[test]
    fn gap_paces_by_the_declared_budget() {
        assert_eq!(gap(600), Duration::from_millis(100));
        assert_eq!(gap(20), Duration::from_millis(3000));
        assert_eq!(gap(0), Duration::from_millis(60_000));
        assert!(src("sec_edgar")["per_min"].as_u64().unwrap() <= 600, "SEC at most 10 a second");
        assert!(gap(src("sec_edgar")["per_min"].as_u64().unwrap()) >= Duration::from_millis(100));
    }

    #[test]
    fn key_reads_the_variable_then_its_file_and_never_an_empty_one() {
        let none = |_: &str| None::<String>;
        assert_eq!(key("FMP_API_KEY", |k| (k == "FMP_API_KEY").then(|| " abc \n".to_string()), none), Some("abc".into()));
        let var = |k: &str| (k == "FMP_API_KEY_FILE").then(|| "/run/secrets/fmp".to_string());
        assert_eq!(key("FMP_API_KEY", var, |p| (p == "/run/secrets/fmp").then(|| "xyz\n".to_string())), Some("xyz".into()));
        assert_eq!(key("FMP_API_KEY", |_| Some("  ".into()), |_| Some(" ".into())), None);
        assert_eq!(key("FMP_API_KEY", none, none), None);
    }

    #[test]
    fn a_keyed_source_without_its_key_needs_one() {
        let fmp = src("fmp");
        assert_eq!(state(&fmp, false, true), "needs_key");
        assert_eq!(state(&fmp, true, false), "ready");
        let r = row(&fmp, "needs_key", None, None);
        assert_eq!(r["status"], "needs_key");
        assert_eq!(r["key_needed"], true);
        assert!(r["reason"].as_str().unwrap().starts_with("FMP needs a free API key"));
        assert_eq!(r["rate_limit"], "5/min, 250/day");
        assert_eq!(state(&src("fred"), false, false), "ready");
        assert_eq!(row(&src("fred"), "ready", Some(7), None)["key_needed"], false);
    }

    #[test]
    fn yahoo_is_off_by_default_and_only_the_last_fallback() {
        let y = src("yahoo");
        assert_eq!(y["flag"]["default"], false);
        assert_eq!(y["flag"]["after"], json!(["cboe", "fred", "coinbase"]));
        assert!(!flag_on(false, None));
        assert!(flag_on(true, None));
        assert!(flag_on(false, Some("1")) && flag_on(false, Some("true")));
        assert!(!flag_on(true, Some("0")));
        assert_eq!(state(&y, true, false), "flag_off");
        assert_eq!(state(&y, true, true), "ready");
        let r = row(&y, "flag_off", None, None);
        assert_eq!(r["reason"], "feature flag FINTERM_YAHOO is off; last fallback after cboe, fred, coinbase");
        assert!(yahoo_wanted(true, false));
        assert!(!yahoo_wanted(true, true));
        assert!(!yahoo_wanted(false, false));
    }

    #[test]
    fn row_rates_and_errors() {
        assert_eq!(row(&src("sec_edgar"), "ready", None, None)["rate_limit"], "10/s");
        assert_eq!(row(&src("fred"), "ready", None, Some("answered 429"))["reason"], "answered 429");
        assert_eq!(row(&src("fred"), "ready", None, None)["reason"], Value::Null);
        assert_eq!(row(&json!({"per_min": 0}), "ready", None, None)["rate_limit"], "0/min");
        assert_eq!(row(&json!({"per_min": 120}), "ready", None, None)["rate_limit"], "2/s");
    }

    #[test]
    fn redact_hides_the_key() {
        assert_eq!(redact("error for url (x?apikey=k-9)", Some("k-9")), "error for url (x?apikey=***)");
        assert_eq!(redact("plain", None), "plain");
        assert_eq!(redact("plain", Some("")), "plain");
    }

    #[test]
    fn openfigi_parses_each_job_in_order() {
        let jobs = vec![json!({"idType": "TICKER", "idValue": "AAPL"}), json!({"idType": "ID_ISIN", "idValue": "X"}), json!({"idType": "ID_ISIN", "idValue": "Y"})];
        let body = r#"[{"data":[{"figi":"BBG000B9XRY4","name":"APPLE INC","ticker":"AAPL","exchCode":"US","marketSector":"Equity","securityType":"Common Stock"}]},{"warning":"No identifier found."},{"error":"Invalid idType"}]"#;
        let v = openfigi_map(body, &jobs);
        assert_eq!(v[0]["figi"], "BBG000B9XRY4");
        assert_eq!(v[0]["query"], "TICKER:AAPL");
        assert_eq!(v[0]["sector"], "Equity");
        assert_eq!(v[1]["figi"], Value::Null);
        assert_eq!(v[1]["error"], "No identifier found.");
        assert_eq!(v[2]["error"], "Invalid idType");
        assert_eq!(openfigi_map("[{}]", &jobs[..1])[0]["error"], "no match");
        assert_eq!(openfigi_map("nope", &jobs), json!([]));
    }

    #[test]
    fn fmp_keeps_every_numeric_field_per_date() {
        let body = r#"[{"symbol":"AAPL","date":"2025-09-27","fiscalYear":"2025","grossProfitMargin":0.469,"currentRatio":0.87},{"symbol":"AAPL","grossProfitMargin":1.0}]"#;
        let o = fmp_ratios(body, "AAPL");
        assert_eq!(o.len(), 2);
        assert!(o.iter().all(|x| x.date == "2025-09-27"));
        let gm = o.iter().find(|x| x.id == "ratio:AAPL:grossProfitMargin").unwrap();
        assert_eq!(gm.value, 0.469);
        assert!(fmp_ratios("{}", "AAPL").is_empty());
    }

    #[test]
    fn sec_filings_keep_the_declared_forms_newest_first() {
        let body = r#"{"name":"Apple Inc.","filings":{"recent":{"form":["4","10-Q","8-K","10-K"],"filingDate":["2026-10-30","2026-08-01","2026-10-01","2026-02-01"],"accessionNumber":["a","b","c","d"],"primaryDocument":["x","q.htm","k8.htm","k.htm"]}}}"#;
        let forms: Vec<String> = ["10-K", "10-Q", "8-K"].iter().map(|s| s.to_string()).collect();
        let v = sec_filings(body, &forms, 2);
        assert_eq!(v["name"], "Apple Inc.");
        let f = v["filings"].as_array().unwrap();
        assert_eq!(f.len(), 2);
        assert_eq!(f[0]["form"], "8-K");
        assert_eq!(f[0]["document"], "k8.htm");
        assert_eq!(f[0]["accession"], "c");
        assert_eq!(f[1]["form"], "10-Q");
        assert_eq!(f[1]["date"], "2026-08-01");
        assert_eq!(sec_filings(body, &forms, 9)["filings"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn sec_facts_read_declared_concepts_from_declared_forms() {
        let body = r#"{"facts":{"us-gaap":{"NetIncomeLoss":{"units":{"USD":[{"end":"2025-09-27","val":112010000000,"form":"10-K"},{"end":"2025-06-28","val":23434000000,"form":"10-Q"},{"end":"2025-06-28","val":1,"form":"S-1"},{"end":"2025-06","val":2,"form":"10-Q"},{"end":"2025-09-27","val":112010000001,"form":"10-K"}]}},"Other":{"units":{"USD":[{"end":"2025-09-27","val":5,"form":"10-K"}]}}}}}"#;
        let c = vec!["NetIncomeLoss".to_string()];
        let f = vec!["10-K".to_string(), "10-Q".to_string()];
        let o = sec_facts(body, "0000320193", &c, &f);
        assert_eq!(o.len(), 2);
        assert_eq!(o[0].id, "fact:0000320193:NetIncomeLoss");
        assert_eq!((o[0].date.as_str(), o[0].value), ("2025-09-27", 112010000001.0));
        assert_eq!((o[1].date.as_str(), o[1].value), ("2025-06-28", 23434000000.0));
    }

    #[test]
    fn yahoo_reads_closes_dividends_and_splits() {
        let body = r#"{"chart":{"result":[{"timestamp":[1730419200,1730505600,1730592000],"indicators":{"quote":[{"close":[225.5,null,0.0],"open":[220.0,1,1],"high":[226.0,1,1],"low":[0.0,1,1]}]},"events":{"dividends":{"1730419200":{"amount":0.25,"date":1730419200}},"splits":{"1598832000":{"numerator":3,"denominator":2,"date":1598832000},"1":{"numerator":2,"denominator":0,"date":1}}}}]}}"#;
        let o = yahoo_chart(body, "AAPL");
        let px: Vec<&Obs> = o.iter().filter(|x| x.id == "px:AAPL").collect();
        assert_eq!(px.len(), 1);
        assert_eq!((px[0].date.as_str(), px[0].value, px[0].o, px[0].h, px[0].l), ("2024-11-01", 225.5, Some(220.0), Some(226.0), None));
        let div = o.iter().find(|x| x.id == "div:AAPL").unwrap();
        assert_eq!((div.date.as_str(), div.value), ("2024-11-01", 0.25));
        let sp: Vec<&Obs> = o.iter().filter(|x| x.id == "split:AAPL").collect();
        assert_eq!(sp.len(), 1);
        assert_eq!((sp[0].date.as_str(), sp[0].value), ("2020-08-31", 1.5));
        assert!(yahoo_chart("{}", "AAPL").is_empty());
    }
}
