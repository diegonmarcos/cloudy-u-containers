//! `/v1`: the FinTerm normalised API (design 3.2), read by the APK (`finterm_v1` connector of Feeds.kt) and the web
//! (`feedV1` of engine.ts). Every answer is built from the jobs whose fetchers.json `serves` names the path, carries
//! `Cache-Control`, `X-Source`, `X-Fetched-At` and `X-Stale: true` when a source failed and the last good copy is served.
//! On a cold cache the matching jobs run once (fetch-through) before answering.

use super::normalise::{Ev, Got, Pt};
use super::scheduler::{collect, refresh};
use super::Job;
use crate::state::AppState;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;

type Q = Query<HashMap<String, String>>;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/catalog", get(catalog))
        .route("/v1/series", get(series))
        .route("/v1/curves/{id}", get(curves))
        .route("/v1/quotes", get(quotes))
        .route("/v1/quotes/{symbol}/history", get(history))
        .route("/v1/fx/spot", get(fx_spot))
        .route("/v1/calendar/economic", get(economic))
        .route("/v1/calendar/earnings", get(earnings))
        .route("/v1/calendar/central-banks", get(central_banks))
        .route("/v1/fundamentals/{symbol}", get(fundamentals))
        .route("/v1/admin/refresh/{job}", post(admin_refresh))
        .merge(super::store::router())
}

/// The jobs serving `path`, run once now when none of them has an answer yet.
async fn gather(s: &AppState, path: &str) -> (Got, Option<String>, bool, Vec<String>) {
    let jobs: Vec<Job> = s.finterm.serving(path).cloned().collect();
    let cold = jobs.iter().all(|j| s.hub.peek(&super::Finterm::topic(&j.id)).is_none());
    if cold {
        for j in &jobs {
            refresh(s, &j.id).await;
        }
    }
    collect(s, jobs.iter())
}

fn answer(body: Value, ttl: u64, fetched: Option<String>, stale: bool, sources: &[String]) -> Response {
    let mut h = HeaderMap::new();
    let put = |h: &mut HeaderMap, k: &'static str, v: String| {
        if let Ok(x) = HeaderValue::from_str(&v) {
            h.insert(k, x);
        }
    };
    put(&mut h, "cache-control", format!("public, max-age={ttl}"));
    put(&mut h, "x-source", sources.join(","));
    if let Some(at) = fetched {
        put(&mut h, "x-fetched-at", at);
    }
    if stale {
        put(&mut h, "x-stale", "true".into());
    }
    (StatusCode::OK, h, Json(body)).into_response()
}

fn none(what: &str) -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": format!("no answer yet for {what}"), "source": "finterm" }))).into_response()
}

fn ttl_of(s: &AppState, path: &str) -> u64 {
    s.finterm.serving(path).map(|j| j.ttl_s).min().unwrap_or(60)
}

/// A symbol across sources: ^SPX, _SPX and spx are one; a series id matches on its last ':' part too.
fn norm(x: &str) -> String {
    let u = x.to_ascii_uppercase();
    let u = u.trim_start_matches(['^', '_']);
    u.rsplit(':').next().unwrap_or(u).to_string()
}

fn list(q: &HashMap<String, String>, k: &str) -> Vec<String> {
    q.get(k).map(|v| v.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()).unwrap_or_default()
}

async fn catalog(State(s): State<AppState>) -> Json<Value> {
    let status = s.finterm.status.lock().expect("status lock").clone();
    let mut jobs: Vec<Value> = s
        .finterm
        .jobs
        .iter()
        .map(|j| {
            let st = status.get(&j.id).cloned().unwrap_or_default();
            json!({ "id": j.id, "source": j.source, "connector": j.connector, "status": if st.status.is_empty() { "pending".to_string() } else { st.status },
                    "last_ok": st.last_ok, "last_error": st.last_error, "runs": st.runs, "ttl_s": j.ttl_s, "serves": j.serves })
        })
        .collect();
    jobs.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    Json(json!({ "declaration_sha": s.finterm.declaration_sha, "v1": s.finterm.v1, "jobs": jobs, "generated_at": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string() }))
}

/// `ids=nyfed:SOFR,bls:CUUR0000SA0,...`: one series per id, `{id, title, obs:[prev, last]}`.
async fn series(State(s): State<AppState>, Query(q): Q) -> Response {
    let (got, at, stale, src) = gather(&s, "/v1/series").await;
    let want = list(&q, "ids");
    let mut out = Vec::new();
    for id in &want {
        // an id is <source>:<key> (nyfed:SOFR, bls:CUUR0000SA0, eurostat:prc_hicp_minr:EA): the key is its last part
        if let Some(p) = got.points.iter().find(|p| norm(&p.key) == norm(id)) {
            let mut obs = Vec::new();
            if let Some(prev) = p.prev {
                obs.push(json!({ "date": "", "value": prev }));
            }
            obs.push(json!({ "date": p.date, "value": p.value }));
            out.push(json!({ "id": id, "title": p.label, "obs": obs }));
        }
    }
    if out.is_empty() && !want.is_empty() {
        return none("these series");
    }
    answer(json!({ "series": out }), ttl_of(&s, "/v1/series"), at, stale, &src)
}

/// `/v1/curves/{id}`: `{asof, points:[{key, label, tenor_years, value}], prev:[{label, value}]}` (tenor from the declared years).
async fn curves(State(s): State<AppState>, Path(id): Path<String>) -> Response {
    // a country (or `matrix`) is served from the yield store; a declared curve id (ust_par, ecb_aaa) from its jobs
    if let Some(r) = super::store::curves(&s, &id).await {
        return r;
    }
    let path = format!("/v1/curves/{id}");
    let (got, at, stale, src) = gather(&s, &path).await;
    if got.points.is_empty() {
        return none(&path);
    }
    let years = s.finterm.serving(&path).find_map(|j| j.opts.get("years").cloned()).unwrap_or(Value::Null);
    let pts: Vec<&Pt> = got.points.iter().filter(|p| years.get(&p.key).is_some() || years.is_null()).collect();
    // two month jobs both contribute a last day: keep, per tenor, the newest observation (first-seen order)
    let mut newest: Vec<&Pt> = Vec::new();
    for p in pts {
        match newest.iter_mut().find(|q| q.key == p.key) {
            Some(q) => {
                if p.date > q.date {
                    *q = p;
                }
            }
            None => newest.push(p),
        }
    }
    let pts = newest;
    let asof = pts.iter().map(|p| p.date.clone()).max().unwrap_or_default();
    let points: Vec<Value> = pts.iter().map(|p| json!({ "key": p.key, "label": p.key, "tenor_years": years.get(&p.key).and_then(Value::as_f64).unwrap_or(p.x), "value": p.value })).collect();
    let prev: Vec<Value> = pts.iter().filter_map(|p| p.prev.map(|v| json!({ "label": p.key, "value": v }))).collect();
    answer(json!({ "id": id, "asof": asof, "points": points, "prev": prev }), ttl_of(&s, &path), at, stale, &src)
}

/// `symbols=^SPX,AAPL,BTC-USD`: the cached quotes of the warm list (Cboe, Coinbase); `{quotes:[{symbol, name, price, prev_close, ts}]}`.
async fn quotes(State(s): State<AppState>, Query(q): Q) -> Response {
    let (got, at, stale, src) = gather(&s, "/v1/quotes").await;
    let want = list(&q, "symbols");
    // no `symbols`: every quote the warm list holds
    let quotes: Vec<Value> = if want.is_empty() {
        got.points.iter().map(|p| json!({ "symbol": p.key, "name": p.key, "price": p.value, "prev_close": p.prev, "ts": p.date })).collect()
    } else {
        want.iter()
            .filter_map(|sym| got.points.iter().find(|p| norm(&p.key) == norm(sym)).map(|p| json!({ "symbol": sym, "name": sym, "price": p.value, "prev_close": p.prev, "ts": p.date })))
            .collect()
    };
    if quotes.is_empty() {
        return none("these symbols");
    }
    answer(json!({ "quotes": quotes }), ttl_of(&s, "/v1/quotes"), at, stale, &src)
}

/// `/v1/quotes/{symbol}/history`: the daily bars of the job whose declared path names the symbol.
async fn history(State(s): State<AppState>, Path(symbol): Path<String>, Query(q): Q) -> Response {
    // a universe symbol is served from the EOD store (SQLite, years of daily closes); any other from its declared job
    if let Some(r) = super::store::history(&s, &symbol, &q).await {
        return r;
    }
    let path = "/v1/quotes/{symbol}/history";
    let want = norm(&symbol);
    let jobs: Vec<Job> = s.finterm.serving(path).filter(|j| norm(&j.path.replace(['/', '.'], " ")).split(' ').any(|w| w == want) || j.path.to_ascii_uppercase().contains(&want)).cloned().collect();
    if jobs.is_empty() {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": format!("no declared history for {symbol}") }))).into_response();
    }
    if jobs.iter().all(|j| s.hub.peek(&super::Finterm::topic(&j.id)).is_none()) {
        for j in &jobs {
            refresh(&s, &j.id).await;
        }
    }
    let (got, at, stale, src) = collect(&s, jobs.iter());
    if got.bars.is_empty() {
        return none(&symbol);
    }
    answer(json!({ "symbol": symbol, "interval": "1d", "bars": got.bars }), jobs.iter().map(|j| j.ttl_s).min().unwrap_or(3600), at, stale, &src)
}

/// `/v1/fx/spot?base=USD&symbols=EUR,JPY`: `{asof, rates:{EUR:..}, prev:{EUR:..}}` (ECB reference rates).
async fn fx_spot(State(s): State<AppState>, Query(q): Q) -> Response {
    let (got, at, stale, src) = gather(&s, "/v1/fx/spot").await;
    let want = list(&q, "symbols");
    let mut rates = serde_json::Map::new();
    let mut prev = serde_json::Map::new();
    let mut asof = String::new();
    for p in &got.points {
        if !want.is_empty() && !want.iter().any(|w| w.eq_ignore_ascii_case(&p.key)) {
            continue;
        }
        rates.insert(p.key.clone(), json!(p.value));
        if let Some(v) = p.prev {
            prev.insert(p.key.clone(), json!(v));
        }
        if p.date > asof {
            asof = p.date.clone();
        }
    }
    if rates.is_empty() {
        return none("fx spot");
    }
    answer(json!({ "base": q.get("base").cloned().unwrap_or_else(|| "USD".into()), "asof": asof, "rates": rates, "prev": prev }), ttl_of(&s, "/v1/fx/spot"), at, stale, &src)
}

/// Events in [today - 1 day, today + days], importance >= `importance`, of `countries` when given; once each, in time order.
fn window(events: Vec<Ev>, q: &HashMap<String, String>, default_days: i64) -> Vec<Ev> {
    let today = super::today();
    let days = q.get("days").and_then(|d| d.parse::<i64>().ok()).unwrap_or(default_days).clamp(1, 120);
    let from = (today - chrono::Duration::days(1)).to_string();
    let to = (today + chrono::Duration::days(days)).to_string();
    let min = q.get("importance").and_then(|d| d.parse::<i64>().ok()).unwrap_or(0);
    let countries: Vec<String> = list(q, "countries").into_iter().map(|c| c.to_ascii_uppercase()).collect();
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<Ev> = events
        .into_iter()
        .filter(|e| e.ts.len() >= 10 && e.ts[..10] >= *from && e.ts[..10] <= *to && e.importance >= min)
        .filter(|e| countries.is_empty() || countries.contains(&e.country))
        .filter(|e| seen.insert(format!("{}|{}|{}", &e.ts[..e.ts.len().min(13)], e.country, e.title.to_lowercase())))
        .collect();
    out.sort_by(|a, b| (&a.ts[..10], if a.ts.len() == 10 { "" } else { a.ts.as_str() }).cmp(&(&b.ts[..10], if b.ts.len() == 10 { "" } else { b.ts.as_str() })));
    out
}

async fn economic(State(s): State<AppState>, Query(q): Q) -> Response {
    let (got, at, stale, src) = gather(&s, "/v1/calendar/economic").await;
    if got.events.is_empty() {
        return none("the economic calendar");
    }
    answer(json!({ "events": window(got.events, &q, 10) }), ttl_of(&s, "/v1/calendar/economic"), at, stale, &src)
}

/// `/v1/calendar/earnings`: SEC EDGAR (store.rs): reported 8-K Item 2.02 filings and estimated next dates, as events + items.
async fn earnings(State(s): State<AppState>, Query(q): Q) -> Response {
    super::store::earnings(&s, &q).await
}

/// Decisions (the declared calendar) and the market-implied odds (Polymarket) as `{events, implied:[{label, prob, ends}]}`.
async fn central_banks(State(s): State<AppState>, Query(q): Q) -> Response {
    let (got, at, stale, src) = gather(&s, "/v1/calendar/central-banks").await;
    if got.is_empty() {
        return none("the central bank calendar");
    }
    let implied: Vec<Value> = got.points.iter().map(|p| json!({ "label": p.label, "prob": p.value, "ends": p.date })).collect();
    let wants_events = q.get("implied").is_none();
    let events = if wants_events { window(got.events, &q, 120) } else { Vec::new() };
    answer(json!({ "events": events, "implied": implied }), ttl_of(&s, "/v1/calendar/central-banks"), at, stale, &src)
}

/// `/v1/fundamentals/{symbol}`: the SEC profile, filings (with links) and the declared concept by fiscal year.
async fn fundamentals(State(s): State<AppState>, Path(symbol): Path<String>, Query(q): Q) -> Response {
    let path = "/v1/fundamentals/{symbol}";
    let (got, at, stale, src) = gather(&s, path).await;
    let ticker = got.kv.iter().find(|(k, _)| k == "Tickers").map(|(_, v)| v.clone()).unwrap_or_default();
    if got.is_empty() || !ticker.split(", ").any(|t| t.eq_ignore_ascii_case(&symbol)) {
        return (StatusCode::NOT_FOUND, Json(json!({ "error": format!("no declared fundamentals for {symbol}") }))).into_response();
    }
    let profile: serde_json::Map<String, Value> = got.kv.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
    let filings: Vec<Value> = got.rows.iter().zip(got.links.iter()).map(|(r, u)| json!({ "title": r.first(), "form": r.get(1), "filed": r.get(2), "url": u })).collect();
    let concept = q.get("concept").cloned().unwrap_or_else(|| "NetIncomeLoss".into());
    let facts: Vec<Value> = got.points.iter().map(|p| json!({ "fy": p.key, "end": p.date, "val": p.value })).collect();
    answer(json!({ "symbol": symbol, "profile": profile, "filings": filings, "facts": { concept: facts } }), ttl_of(&s, path), at, stale, &src)
}

/// Mesh only: a request that came through the edge (Caddy sets X-Forwarded-For) is refused.
async fn admin_refresh(State(s): State<AppState>, Path(job): Path<String>, headers: HeaderMap) -> Response {
    if headers.contains_key("x-forwarded-for") {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "mesh only" }))).into_response();
    }
    if refresh(&s, &job).await {
        (StatusCode::OK, Json(json!({ "job": job, "status": "ok" }))).into_response()
    } else {
        (StatusCode::BAD_GATEWAY, Json(json!({ "job": job, "status": "failed or unknown" }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(ts: &str, imp: i64, c: &str, title: &str) -> Ev {
        Ev { ts: ts.into(), country: c.into(), title: title.into(), importance: imp, ..Default::default() }
    }

    #[test]
    fn symbols_match_across_sources() {
        assert_eq!(norm("^spx"), "SPX");
        assert_eq!(norm("_SPX"), "SPX");
        assert_eq!(norm("nyfed:SOFR"), "SOFR");
    }

    #[test]
    fn the_window_filters_importance_country_and_dedupes_in_time_order() {
        let t = super::super::today();
        let d = |n: i64| (t + chrono::Duration::days(n)).to_string();
        let evs = vec![
            ev(&format!("{}T13:30Z", d(2)), 3, "US", "NFP"),
            ev(&format!("{}T13:30Z", d(2)), 3, "US", "nfp"),
            ev(&d(1), 3, "JP", "holiday"),
            ev(&format!("{}T08:00Z", d(1)), 1, "EA", "minor"),
            ev(&format!("{}T08:00Z", d(30)), 3, "US", "far"),
            ev(&format!("{}T08:00Z", d(-5)), 3, "US", "past"),
        ];
        let q: HashMap<String, String> = [("importance".to_string(), "2".to_string())].into_iter().collect();
        assert_eq!(window(evs.clone(), &q, 10).iter().map(|e| e.title.as_str()).collect::<Vec<_>>(), vec!["holiday", "NFP"]);
        let q: HashMap<String, String> = [("countries".to_string(), "us".to_string()), ("days".to_string(), "40".to_string())].into_iter().collect();
        assert_eq!(window(evs, &q, 10).iter().map(|e| e.title.as_str()).collect::<Vec<_>>(), vec!["NFP", "far"]);
    }
}
