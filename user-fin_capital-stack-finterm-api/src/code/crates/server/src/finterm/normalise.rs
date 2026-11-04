//! The connectors' answers -> the FinTerm model (design 3.2), the same shapes the APK's Feeds.kt and the web's engine.ts
//! produce: points (series values, quotes, curve tenors), events (calendars), bars, key/value rows, rows with links.
//! Pure functions: an answer's text and the job's options in, a `Got` out; anything unrecognised is an empty `Got`.

use chrono::{DateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The connectors this module implements (the generator emits no job for any other; mod.rs refuses one).
pub const CONNECTORS: &[&str] = &[
    "ff_calendar", "declared_events", "cboe_quotes", "nyfed_rates", "treasury_xml", "frankfurter_rates",
    "coinbase_exchange", "polymarket_events", "bls_series", "sec_submissions", "sec_concept",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Pt {
    pub key: String,
    pub label: String,
    pub x: f64,
    pub value: f64,
    pub prev: Option<f64>,
    pub date: String,
}

/// `ts` is UTC "YYYY-MM-DDTHH:MMZ", or "YYYY-MM-DD" for an all-day event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Ev {
    pub ts: String,
    pub country: String,
    pub title: String,
    pub importance: i64,
    pub consensus: String,
    pub actual: String,
    pub previous: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Bar {
    pub t: String,
    pub o: f64,
    pub h: f64,
    pub l: f64,
    pub c: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Got {
    pub points: Vec<Pt>,
    pub events: Vec<Ev>,
    pub bars: Vec<Bar>,
    pub kv: Vec<(String, String)>,
    pub rows: Vec<Vec<String>>,
    pub links: Vec<String>,
}

impl Got {
    pub fn is_empty(&self) -> bool {
        self.points.is_empty() && self.events.is_empty() && self.bars.is_empty() && self.kv.is_empty() && self.rows.is_empty()
    }
    pub fn extend(&mut self, o: Got) {
        self.points.extend(o.points);
        self.events.extend(o.events);
        self.bars.extend(o.bars);
        self.kv.extend(o.kv);
        self.rows.extend(o.rows);
        self.links.extend(o.links);
    }
}

/// `each` is the item a per-item request was made for; `opts` the job's declared options; `paths` the source's declared paths.
pub fn parse(connector: &str, body: &str, opts: &Value, each: &str, paths: &Value) -> Got {
    let json = || serde_json::from_str::<Value>(body).unwrap_or(Value::Null);
    match connector {
        "ff_calendar" => ff(&json()),
        "declared_events" => declared(&json()),
        "cboe_quotes" => cboe(&json(), each, opts.get("last").and_then(Value::as_u64).unwrap_or(252) as usize),
        "nyfed_rates" => nyfed(&json()),
        "treasury_xml" => treasury(body),
        "frankfurter_rates" => frankfurter(&json()),
        "coinbase_exchange" => coinbase(&json(), each),
        "polymarket_events" => polymarket(&json(), opts.get("last").and_then(Value::as_u64).unwrap_or(12) as usize),
        "bls_series" => bls(&json()),
        "sec_submissions" => sec(&json(), opts, paths),
        "sec_concept" => sec_concept(&json(), opts.get("scale").and_then(Value::as_f64).unwrap_or(1.0), opts.get("last").and_then(Value::as_u64).unwrap_or(6) as usize),
        _ => Got::default(),
    }
}

fn s(v: &Value, k: &str) -> String {
    match v.get(k) {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

/// A number field, also when published as text; None when absent or not finite.
fn num(v: &Value, k: &str) -> Option<f64> {
    let n = match v.get(k)? {
        Value::Number(n) => n.as_f64()?,
        Value::String(x) => x.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    n.is_finite().then_some(n)
}

fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}

/// An RFC 3339 instant ("2026-11-06T08:30:00-05:00") as UTC "2026-11-06T13:30Z"; a bare date stays a date.
pub fn utc(raw: &str) -> Option<String> {
    if raw.len() == 10 && chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d").is_ok() {
        return Some(raw.to_string());
    }
    DateTime::parse_from_rfc3339(raw).ok().map(|d| d.with_timezone(&Utc).format("%Y-%m-%dT%H:%MZ").to_string())
}

pub fn country(ccy: &str) -> String {
    match ccy.to_ascii_uppercase().as_str() {
        "USD" => "US", "EUR" => "EA", "GBP" => "GB", "JPY" => "JP", "CNY" => "CN", "CAD" => "CA", "AUD" => "AU", "NZD" => "NZ", "CHF" => "CH",
        other => return other.to_string(),
    }
    .to_string()
}

pub fn importance(impact: &str) -> i64 {
    match impact.to_ascii_lowercase().as_str() {
        "high" => 3,
        "medium" => 2,
        "low" => 1,
        _ => 0,
    }
}

/// Forex Factory weekly feed.
pub fn ff(v: &Value) -> Got {
    let events = arr(v)
        .iter()
        .filter_map(|e| {
            Some(Ev {
                ts: utc(&s(e, "date"))?,
                country: country(&s(e, "country")),
                title: s(e, "title"),
                importance: importance(&s(e, "impact")),
                consensus: s(e, "forecast"),
                actual: s(e, "actual"),
                previous: s(e, "previous"),
                kind: "economic".into(),
            })
        })
        .collect();
    Got { events, ..Default::default() }
}

/// The declared central bank calendar: banks[].events[] of {ts, title}, importance 3.
pub fn declared(v: &Value) -> Got {
    let mut events = Vec::new();
    for b in arr(v.get("banks").unwrap_or(&Value::Null)) {
        for e in arr(b.get("events").unwrap_or(&Value::Null)) {
            events.push(Ev { ts: s(e, "ts"), country: s(b, "country"), title: s(e, "title"), importance: 3, kind: "central_bank".into(), ..Default::default() });
        }
    }
    Got { events, ..Default::default() }
}

/// Cboe delayed quotes: a quote ({data:{current_price, prev_day_close, last_trade_time}}) or a daily history ({data:[...]}).
pub fn cboe(v: &Value, each: &str, last: usize) -> Got {
    match v.get("data") {
        Some(Value::Array(a)) => {
            let mut bars: Vec<Bar> = a
                .iter()
                .filter_map(|d| {
                    let c = num(d, "close")?;
                    Some(Bar { t: s(d, "date"), o: num(d, "open").unwrap_or(c), h: num(d, "high").unwrap_or(c), l: num(d, "low").unwrap_or(c), c })
                })
                .collect();
            bars.sort_by(|a, b| a.t.cmp(&b.t));
            let skip = bars.len().saturating_sub(last.max(1));
            Got { bars: bars.split_off(skip), ..Default::default() }
        }
        Some(d @ Value::Object(_)) => match num(d, "current_price") {
            Some(p) => {
                let key = if each.is_empty() { s(d, "symbol") } else { each.to_string() };
                let date: String = s(d, "last_trade_time").chars().take(16).collect::<String>().replace('T', " ");
                Got { points: vec![Pt { label: key.clone(), key, x: 0.0, value: p, prev: num(d, "price_change").map(|c| p - c).or_else(|| num(d, "prev_day_close")), date }], ..Default::default() }
            }
            None => Got::default(),
        },
        _ => Got::default(),
    }
}

/// NY Fed rates/all/latest: one point per rate; SOFRAI gives the 30/90/180-day averages and the index.
pub fn nyfed(v: &Value) -> Got {
    let mut out = Vec::new();
    for r in arr(v.get("refRates").unwrap_or(&Value::Null)) {
        let ty = s(r, "type");
        let date = s(r, "effectiveDate");
        if ty == "SOFRAI" {
            for (k, f) in [("SOFRAI_30D", "average30day"), ("SOFRAI_90D", "average90day"), ("SOFRAI_180D", "average180day"), ("SOFRAI_INDEX", "index")] {
                if let Some(x) = num(r, f) {
                    out.push(Pt { key: k.into(), label: k.into(), x: out.len() as f64, value: x, prev: None, date: date.clone() });
                }
            }
        } else if let Some(x) = num(r, "percentRate") {
            out.push(Pt { key: ty.clone(), label: ty, x: out.len() as f64, value: x, prev: None, date });
        }
    }
    Got { points: out, ..Default::default() }
}

/// Treasury par yield curve XML: the last day of the answer, the day before as prev, one point per BC_* tenor.
pub fn treasury(body: &str) -> Got {
    let mut days: Vec<(String, Vec<(String, f64)>)> = Vec::new();
    for chunk in body.split("<m:properties>").skip(1) {
        let chunk = chunk.split("</m:properties>").next().unwrap_or("");
        let date = match chunk.find("<d:NEW_DATE") {
            Some(i) => {
                let rest = &chunk[i..];
                match rest.find('>') {
                    Some(j) => rest[j + 1..].chars().take(10).collect::<String>(),
                    None => continue,
                }
            }
            None => continue,
        };
        let mut vals = Vec::new();
        let mut rest = chunk;
        while let Some(i) = rest.find("<d:BC_") {
            let tag = &rest[i + 3..];
            let name: String = tag.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
            let after = match tag.find('>') {
                Some(j) => &tag[j + 1..],
                None => break,
            };
            let text: String = after.chars().take_while(|c| *c != '<').collect();
            if let Ok(x) = text.trim().parse::<f64>() {
                vals.push((name, x));
            }
            rest = after;
        }
        if date.len() == 10 && !vals.is_empty() {
            days.push((date, vals));
        }
    }
    days.sort_by(|a, b| a.0.cmp(&b.0));
    let Some((date, last)) = days.last().cloned() else { return Got::default() };
    let prev = if days.len() >= 2 { Some(days[days.len() - 2].1.clone()) } else { None };
    let points = last
        .iter()
        .enumerate()
        .map(|(i, (k, x))| Pt {
            key: k.clone(),
            label: k.clone(),
            x: i as f64,
            value: *x,
            prev: prev.as_ref().and_then(|p| p.iter().find(|(pk, _)| pk == k).map(|(_, v)| *v)),
            date: date.clone(),
        })
        .collect();
    Got { points, ..Default::default() }
}

/// Frankfurter latest ({date, rates:{EUR}}) or range ({rates:{date:{EUR}}}): per currency the last fix and the one before.
pub fn frankfurter(v: &Value) -> Got {
    let Some(rates) = v.get("rates").and_then(Value::as_object) else { return Got::default() };
    let mut keys: Vec<&String> = rates.keys().collect();
    keys.sort();
    if keys.is_empty() {
        return Got::default();
    }
    if rates[keys[0]].is_object() {
        let last_day = keys[keys.len() - 1];
        let prev_day = if keys.len() >= 2 { Some(keys[keys.len() - 2]) } else { None };
        let last = &rates[last_day];
        let mut ccys: Vec<&String> = last.as_object().map(|o| o.keys().collect()).unwrap_or_default();
        ccys.sort();
        let points = ccys
            .iter()
            .enumerate()
            .filter_map(|(i, c)| {
                Some(Pt {
                    key: (*c).clone(),
                    label: (*c).clone(),
                    x: i as f64,
                    value: num(last, c)?,
                    prev: prev_day.and_then(|d| num(&rates[d], c)),
                    date: last_day.clone(),
                })
            })
            .collect();
        return Got { points, ..Default::default() };
    }
    let date = s(v, "date");
    let points = keys
        .iter()
        .enumerate()
        .filter_map(|(i, c)| Some(Pt { key: (*c).clone(), label: (*c).clone(), x: i as f64, value: rates[*c].as_f64()?, prev: None, date: date.clone() }))
        .collect();
    Got { points, ..Default::default() }
}

/// Coinbase Exchange: products/{id}/stats ({open, last}) or candles ([[time, low, high, open, close, volume]], newest first).
pub fn coinbase(v: &Value, each: &str) -> Got {
    if let Some(a) = v.as_array() {
        let mut bars: Vec<Bar> = a
            .iter()
            .filter_map(|c| {
                let c = c.as_array()?;
                if c.len() < 5 {
                    return None;
                }
                let t = Utc.timestamp_opt(c[0].as_i64()?, 0).single()?.format("%Y-%m-%d").to_string();
                Some(Bar { t, o: c[3].as_f64()?, h: c[2].as_f64()?, l: c[1].as_f64()?, c: c[4].as_f64()? })
            })
            .collect();
        bars.sort_by(|a, b| a.t.cmp(&b.t));
        return Got { bars, ..Default::default() };
    }
    match num(v, "last") {
        Some(last) => Got { points: vec![Pt { key: each.into(), label: each.into(), x: 0.0, value: last, prev: num(v, "open"), date: "24h".into() }], ..Default::default() },
        None => Got::default(),
    }
}

/// Polymarket Gamma events: per open market its label and the first outcome's price as a percent.
pub fn polymarket(v: &Value, last: usize) -> Got {
    let mut out = Vec::new();
    for e in arr(v) {
        for m in arr(e.get("markets").unwrap_or(&Value::Null)) {
            if m.get("closed").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let prices: Value = serde_json::from_str(&s(m, "outcomePrices")).unwrap_or(Value::Null);
            let Some(p) = prices.get(0).and_then(|x| x.as_str().and_then(|t| t.parse::<f64>().ok()).or_else(|| x.as_f64())) else { continue };
            let label = Some(s(m, "groupItemTitle")).filter(|x| !x.is_empty()).unwrap_or_else(|| s(m, "question"));
            let key = Some(s(m, "slug")).filter(|x| !x.is_empty()).unwrap_or_else(|| label.clone());
            out.push(Pt { key, label: format!("{}: {}", s(e, "title"), label), x: out.len() as f64, value: p * 100.0, prev: None, date: s(e, "endDate").chars().take(10).collect() });
        }
    }
    out.truncate(last.max(1));
    Got { points: out, ..Default::default() }
}

/// BLS v2: per series the newest print and the one before.
pub fn bls(v: &Value) -> Got {
    let series = v.get("Results").and_then(|r| r.get("series")).map(arr).unwrap_or(&[]);
    let mut out = Vec::new();
    for sr in series {
        let mut data: Vec<(String, f64)> = arr(sr.get("data").unwrap_or(&Value::Null))
            .iter()
            .filter_map(|d| {
                let x = num(d, "value")?;
                let p = s(d, "period");
                let period = if p.starts_with('M') && p != "M13" { format!("{}-{}", s(d, "year"), &p[1..]) } else { s(d, "year") };
                Some((period, x))
            })
            .collect();
        data.sort_by(|a, b| b.0.cmp(&a.0));
        if let Some((date, x)) = data.first().cloned() {
            let id = s(sr, "seriesID");
            out.push(Pt { key: id.clone(), label: id, x: out.len() as f64, value: x, prev: data.get(1).map(|d| d.1), date });
        }
    }
    Got { points: out, ..Default::default() }
}

/// SEC submissions: the profile (key/value) and the recent filings of the declared forms with their links.
pub fn sec(v: &Value, opts: &Value, paths: &Value) -> Got {
    let list = |k: &str| arr(v.get(k).unwrap_or(&Value::Null)).iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ");
    let fy = s(v, "fiscalYearEnd");
    let kv: Vec<(String, String)> = vec![
        ("Name", s(v, "name")),
        ("Tickers", list("tickers")),
        ("Exchanges", list("exchanges")),
        ("Industry", s(v, "sicDescription")),
        ("Filer category", s(v, "category")),
        ("Fiscal year end", if fy.len() == 4 { format!("{}-{}", &fy[..2], &fy[2..]) } else { fy }),
        ("State of incorporation", s(v, "stateOfIncorporation")),
        ("CIK", s(v, "cik")),
    ]
    .into_iter()
    .filter(|(_, x)| !x.trim().is_empty())
    .map(|(k, x)| (k.to_string(), x))
    .collect();
    let Some(r) = v.get("filings").and_then(|f| f.get("recent")) else { return Got { kv, ..Default::default() } };
    let col = |k: &str, i: usize| r.get(k).and_then(|a| a.get(i)).and_then(Value::as_str).unwrap_or_default().to_string();
    let forms = arr(r.get("form").unwrap_or(&Value::Null));
    let want: Vec<&str> = arr(opts.get("forms").unwrap_or(&Value::Null)).iter().filter_map(Value::as_str).collect();
    let max = opts.get("last").and_then(Value::as_u64).unwrap_or(12) as usize;
    let cik = s(v, "cik").trim_start_matches('0').to_string();
    let template = paths.get("filing").and_then(Value::as_str).unwrap_or_default();
    let (mut rows, mut links) = (Vec::new(), Vec::new());
    for (i, f) in forms.iter().enumerate() {
        let form = f.as_str().unwrap_or_default();
        if !want.is_empty() && !want.contains(&form) {
            continue;
        }
        let desc = Some(col("primaryDocDescription", i)).filter(|d| !d.trim().is_empty()).unwrap_or_else(|| form.to_string());
        rows.push(vec![desc, form.to_string(), col("filingDate", i)]);
        links.push(if template.is_empty() {
            String::new()
        } else {
            template.replace("{cik}", &cik).replace("{accession}", &col("accessionNumber", i).replace('-', "")).replace("{document}", &col("primaryDocument", i))
        });
        if rows.len() >= max {
            break;
        }
    }
    Got { kv, rows, links, ..Default::default() }
}

/// SEC companyconcept: the full-year values (frame CYyyyy, last filed wins), scaled, the last N years, each with the year before.
pub fn sec_concept(v: &Value, scale: f64, last: usize) -> Got {
    let Some(units) = v.get("units").and_then(Value::as_object) else { return Got::default() };
    let mut names: Vec<&String> = units.keys().collect();
    names.sort();
    let Some(unit) = names.first() else { return Got::default() };
    let mut by_year: std::collections::BTreeMap<String, (String, f64)> = Default::default();
    for f in arr(&units[*unit]) {
        let frame = s(f, "frame");
        let ok = frame.len() == 6 && frame.starts_with("CY") && frame[2..].chars().all(|c| c.is_ascii_digit());
        if let (true, Some(x)) = (ok, num(f, "val")) {
            by_year.insert(frame[2..].to_string(), (s(f, "end"), x * scale));
        }
    }
    let years: Vec<(String, (String, f64))> = by_year.into_iter().collect();
    let all: Vec<Pt> = years
        .iter()
        .enumerate()
        .map(|(i, (y, (end, x)))| Pt { key: y.clone(), label: y.clone(), x: i as f64, value: *x, prev: if i > 0 { Some(years[i - 1].1 .1) } else { None }, date: end.clone() })
        .collect();
    let skip = all.len().saturating_sub(last.max(1));
    let points = all.into_iter().skip(skip).enumerate().map(|(i, p)| Pt { x: i as f64, ..p }).collect();
    Got { points, ..Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(c: &str, body: &str) -> Got {
        parse(c, body, &json!({}), "", &json!({}))
    }

    #[test]
    fn forex_factory_is_utc_with_country_and_importance() {
        let body = r#"[{"title":"Non-Farm Employment Change","country":"USD","date":"2026-11-06T08:30:00-05:00","impact":"High","forecast":"180K","previous":"254K"},
            {"title":"German Prelim CPI m/m","country":"EUR","date":"2026-10-30T09:00:00+01:00","impact":"Medium","forecast":"0.2%","previous":"0.1%"},
            {"title":"Bank Holiday","country":"JPY","date":"2026-11-03T00:00:00+09:00","impact":"Holiday","forecast":"","previous":""},
            {"title":"bad date","country":"USD","date":"soon","impact":"High"}]"#;
        let e = p("ff_calendar", body).events;
        assert_eq!(e.len(), 3);
        assert_eq!((e[0].ts.as_str(), e[0].country.as_str(), e[0].importance, e[0].consensus.as_str(), e[0].previous.as_str()), ("2026-11-06T13:30Z", "US", 3, "180K", "254K"));
        assert_eq!((e[1].ts.as_str(), e[1].country.as_str(), e[1].importance), ("2026-10-30T08:00Z", "EA", 2));
        assert_eq!((e[2].ts.as_str(), e[2].importance), ("2026-11-02T15:00Z", 0));
        assert_eq!(importance("Low"), 1);
        assert_eq!(country("gbp"), "GB");
    }

    #[test]
    fn declared_decisions_are_importance_three() {
        let g = p("declared_events", r#"{"banks":[{"country":"US","events":[{"ts":"2026-12-09T19:00Z","title":"Fed: rate decision"}]}]}"#);
        assert_eq!(g.events, vec![Ev { ts: "2026-12-09T19:00Z".into(), country: "US".into(), title: "Fed: rate decision".into(), importance: 3, kind: "central_bank".into(), ..Default::default() }]);
    }

    #[test]
    fn cboe_quote_and_history() {
        let q = parse("cboe_quotes", r#"{"data":{"symbol":"^SPX","current_price":7580.07,"prev_day_close":7720.39,"last_trade_time":"2026-10-30T16:14:58"}}"#, &json!({}), "_SPX", &json!({})).points;
        assert_eq!(q, vec![Pt { key: "_SPX".into(), label: "_SPX".into(), x: 0.0, value: 7580.07, prev: Some(7720.39), date: "2026-10-30 16:14".into() }]);
        // After the US close Cboe resets prev_day_close to the current price; prev must come from price_change instead.
        let d = parse("cboe_quotes", r#"{"data":{"symbol":"^DJX","current_price":475.12,"price_change":-3.41,"prev_day_close":475.12,"last_trade_time":"2026-10-30T16:14:58"}}"#, &json!({}), "_DJX", &json!({})).points;
        assert!((d[0].prev.unwrap() - 478.53).abs() < 1e-9, "prev = price - price_change, not the reset prev_day_close");
        let h = parse("cboe_quotes", r#"{"data":[{"date":"2026-10-29","open":"1","high":"3","low":"0.5","close":"2"},{"date":"2026-10-28","close":"1.5"},{"date":"2026-10-30","open":"2","high":"4","low":"2","close":"3"}]}"#, &json!({"last":2}), "", &json!({})).bars;
        assert_eq!(h.iter().map(|b| b.t.as_str()).collect::<Vec<_>>(), vec!["2026-10-29", "2026-10-30"]);
        assert_eq!(h[0].h, 3.0);
    }

    #[test]
    fn nyfed_splits_the_sofr_averages() {
        let g = p("nyfed_rates", r#"{"refRates":[{"effectiveDate":"2026-10-30","type":"SOFRAI","average30day":3.89857,"average90day":3.77,"average180day":3.71,"index":1.26},{"effectiveDate":"2026-10-29","type":"SOFR","percentRate":3.91}]}"#);
        assert_eq!(g.points.iter().map(|x| x.key.as_str()).collect::<Vec<_>>(), vec!["SOFRAI_30D", "SOFRAI_90D", "SOFRAI_180D", "SOFRAI_INDEX", "SOFR"]);
        assert_eq!(g.points[4].value, 3.91);
    }

    #[test]
    fn treasury_takes_the_last_day_and_the_day_before() {
        let day = |d: &str, ten: &str| format!(r#"<m:properties><d:NEW_DATE m:type="Edm.DateTime">{d}T00:00:00</d:NEW_DATE><d:BC_2YEAR m:type="Edm.Double">3.5</d:BC_2YEAR><d:BC_10YEAR m:type="Edm.Double">{ten}</d:BC_10YEAR></m:properties>"#);
        let g = treasury(&format!("<feed>{}{}{}</feed>", day("2026-10-29", "4.10"), day("2026-10-01", "4.00"), day("2026-10-30", "4.15")));
        assert_eq!(g.points.iter().map(|x| x.key.as_str()).collect::<Vec<_>>(), vec!["BC_2YEAR", "BC_10YEAR"]);
        assert_eq!((g.points[1].value, g.points[1].prev, g.points[1].date.as_str()), (4.15, Some(4.10), "2026-10-30"));
        assert!(treasury("<html>429</html>").is_empty());
    }

    #[test]
    fn frankfurter_latest_and_range() {
        let r = p("frankfurter_rates", r#"{"rates":{"2026-10-30":{"EUR":0.90},"2026-10-28":{"EUR":0.88},"2026-10-29":{"EUR":0.89}}}"#).points;
        assert_eq!((r[0].value, r[0].prev, r[0].date.as_str()), (0.90, Some(0.89), "2026-10-30"));
        let l = p("frankfurter_rates", r#"{"date":"2026-10-30","rates":{"JPY":157.25,"EUR":0.895}}"#).points;
        assert_eq!(l.iter().map(|x| x.key.as_str()).collect::<Vec<_>>(), vec!["EUR", "JPY"]);
    }

    #[test]
    fn coinbase_stats_and_candles() {
        let q = parse("coinbase_exchange", r#"{"open":"100","last":"110"}"#, &json!({}), "BTC-USD", &json!({})).points;
        assert_eq!((q[0].key.as_str(), q[0].value, q[0].prev), ("BTC-USD", 110.0, Some(100.0)));
        let b = p("coinbase_exchange", "[[1793318400,76141.02,78634.8,77782.75,77048.02,1.0],[1793232000,77699,81890,81249.32,77780.33,1.0]]").bars;
        assert!(b[0].t < b[1].t);
        assert_eq!((b[1].o, b[1].h, b[1].l, b[1].c), (77782.75, 78634.8, 76141.02, 77048.02));
    }

    #[test]
    fn polymarket_open_markets_as_percent() {
        let g = p("polymarket_events", r#"[{"title":"Fed in December?","endDate":"2026-12-10T00:00:00Z","markets":[{"groupItemTitle":"25 bps decrease","slug":"cut","outcomePrices":"[\"0.62\", \"0.38\"]"},{"groupItemTitle":"x","closed":true,"outcomePrices":"[\"0.5\"]"}]}]"#);
        assert_eq!(g.points.len(), 1);
        assert!((g.points[0].value - 62.0).abs() < 1e-9);
        assert_eq!((g.points[0].label.as_str(), g.points[0].date.as_str()), ("Fed in December?: 25 bps decrease", "2026-12-10"));
    }

    #[test]
    fn bls_newest_and_previous() {
        let g = p("bls_series", r#"{"Results":{"series":[{"seriesID":"LNS14000000","data":[{"year":"2026","period":"M08","value":"4.3"},{"year":"2026","period":"M09","value":"4.2"},{"year":"2026","period":"M07","value":"-"}]}]}}"#);
        assert_eq!((g.points[0].value, g.points[0].prev, g.points[0].date.as_str()), (4.2, Some(4.3), "2026-09"));
    }

    #[test]
    fn sec_profile_filings_and_concept() {
        let body = r#"{"cik":"0000320193","name":"Apple Inc.","tickers":["AAPL"],"fiscalYearEnd":"0926","filings":{"recent":{"accessionNumber":["a-1","0000320193-26-000020"],"filingDate":["2026-10-29","2026-07-31"],"form":["4","10-Q"],"primaryDocument":["f.xml","aapl.htm"],"primaryDocDescription":["",""]}}}"#;
        let g = parse("sec_submissions", body, &json!({"forms":["10-Q"]}), "", &json!({"filing":"base/{cik}/{accession}/{document}"}));
        assert!(g.kv.contains(&("Fiscal year end".to_string(), "09-26".to_string())));
        assert_eq!(g.rows, vec![vec!["10-Q".to_string(), "10-Q".to_string(), "2026-07-31".to_string()]]);
        assert_eq!(g.links, vec!["base/320193/000032019326000020/aapl.htm".to_string()]);
        let c = r#"{"units":{"USD":[{"end":"2024-09-28","val":93736000000,"frame":"CY2024"},{"end":"2025-09-27","val":112010000000,"frame":"CY2025"},{"end":"2026-06-27","val":29789000000,"frame":"CY2026Q2"}]}}"#;
        let pts = parse("sec_concept", c, &json!({"scale":1e-9,"last":1}), "", &json!({})).points;
        assert_eq!(pts.len(), 1);
        assert!((pts[0].value - 112.01).abs() < 1e-9 && (pts[0].prev.unwrap() - 93.736).abs() < 1e-9);
        assert_eq!((pts[0].key.as_str(), pts[0].x), ("2025", 0.0));
    }

    #[test]
    fn garbage_is_empty_never_a_panic() {
        for c in CONNECTORS {
            assert!(p(c, "<html>429 rate limited</html>").is_empty(), "{c}");
            assert!(p(c, "").is_empty(), "{c}");
        }
    }
}
