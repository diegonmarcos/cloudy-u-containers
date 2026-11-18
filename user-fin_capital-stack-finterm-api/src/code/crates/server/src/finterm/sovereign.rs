//! `/v1/rates/sovereign-curves` (#1786): the government yield curves FinTerm's CB/Home reads for GB, JP and CN, straight from the
//! issuers' free public files. The sources are declared in `src/code/sovereign-curves.json` (embedded; no address is typed here),
//! tried per country in order (primary, then fallbacks). Each country is fetched, cached and failed on its own: a country whose
//! sources all fail serves its last good curve marked stale, or is listed under `unavailable` with the reason. A tenor a source
//! does not publish is left out, never interpolated or made up. The cache lives in memory (TTL `ttl_s`, a failure retried after
//! `retry_s`) and, when the server has a FinTerm database (FINTERM_DB), in `fin_doc` as `sovereign:<CC>`, so a restart serves at once.
//!
//! The parsers are pure (bytes in, points out) and tested on recorded answers under `tests/fixtures/sovereign/`.

use crate::state::AppState;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{Duration as Days, NaiveDate};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::Read;
use std::sync::Arc;

/// The API-owned declaration, embedded at build time.
pub const DECL_JSON: &str = include_str!("../../../../sovereign-curves.json");

/// The formats `parse` implements.
pub const FORMATS: &[&str] = &["boe_glc_zip", "boe_iadb_csv", "mof_jgb_csv", "chinabond_chart_json", "chinabond_table_html"];

/// One observation: a yield in % at a maturity in years on a day.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Point {
    pub years: f64,
    pub date: String,
    pub value: f64,
}

/// A country's last good answer (and the last try).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct Entry {
    pub points: Vec<Point>,
    pub source: String,
    pub name: String,
    pub licence: String,
    /// Unix seconds of the last success (0 = never).
    pub fetched_at: i64,
    /// Unix seconds of the last try.
    #[serde(default)]
    pub tried_at: i64,
    #[serde(default)]
    pub error: Option<String>,
}

/// The declaration and one cache slot per declared country (a slot's lock is held through its refresh: one fetch at a time per country).
pub struct Sovereign {
    pub decl: Value,
    slots: HashMap<String, Arc<tokio::sync::Mutex<Option<Entry>>>>,
}

impl Default for Sovereign {
    fn default() -> Self {
        Self::from_json(DECL_JSON).expect("sovereign-curves.json is valid")
    }
}

impl Sovereign {
    pub fn from_json(text: &str) -> anyhow::Result<Self> {
        let decl: Value = serde_json::from_str(text)?;
        let mut slots = HashMap::new();
        for (cc, srcs) in decl["countries"].as_object().cloned().unwrap_or_default() {
            for s in srcs.as_array().cloned().unwrap_or_default() {
                let f = s["format"].as_str().unwrap_or_default();
                if !FORMATS.contains(&f) {
                    anyhow::bail!("sovereign-curves.json {cc}/{} names format {f} that sovereign.rs does not parse", s["id"]);
                }
            }
            slots.insert(cc, Arc::new(tokio::sync::Mutex::new(None)));
        }
        Ok(Self { decl, slots })
    }

    fn ttl(&self) -> i64 {
        self.decl["ttl_s"].as_i64().unwrap_or(21_600)
    }

    fn retry(&self) -> i64 {
        self.decl["retry_s"].as_i64().unwrap_or(900)
    }
}

// ---------------------------------------------------------------- parsers (pure)

/// One source's answer -> every observation it holds. `src` is the source's declaration.
pub fn parse(format: &str, body: &[u8], src: &Value) -> anyhow::Result<Vec<Point>> {
    let text = || String::from_utf8_lossy(body).into_owned();
    let mut pts = match format {
        "boe_glc_zip" => boe_glc_zip(body, src)?,
        "boe_iadb_csv" => boe_iadb_csv(&text(), src),
        "mof_jgb_csv" => mof_jgb_csv(&text()),
        "chinabond_chart_json" => chinabond_chart_json(&text(), src)?,
        "chinabond_table_html" => chinabond_table_html(&text()),
        other => anyhow::bail!("unknown format {other}"),
    };
    // a yield outside (-20 %, 100 %) is a parsing accident, not a market
    pts.retain(|p| p.value.is_finite() && p.value > -20.0 && p.value < 100.0 && p.years > 0.0);
    if pts.is_empty() {
        anyhow::bail!("the answer parsed to nothing");
    }
    Ok(pts)
}

/// A tenor as asked: `2`, `2Y`, `0.5`, `6M` -> years.
pub fn tenor_years(t: &str) -> Option<f64> {
    let u = t.trim().to_ascii_uppercase();
    let (num, scale) = if let Some(m) = u.strip_suffix('M') {
        (m, 1.0 / 12.0)
    } else if let Some(y) = u.strip_suffix('Y') {
        (y, 1.0)
    } else {
        (u.as_str(), 1.0)
    };
    let v: f64 = num.trim().parse().ok()?;
    (v > 0.0 && v <= 100.0).then_some(v * scale)
}

fn same_tenor(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-6
}

/// Per tenor, the newest observation.
pub fn newest(points: &[Point], years: f64) -> Option<&Point> {
    points.iter().filter(|p| same_tenor(p.years, years)).max_by(|a, b| a.date.cmp(&b.date))
}

/// Ministry of Finance Japan `jgbcme.csv` / `jgbcme_all.csv`: a title line, `Date,1Y,2Y,...,40Y`, then `2026/11/2,1.671,...`; `-` = none.
pub fn mof_jgb_csv(body: &str) -> Vec<Point> {
    let lines: Vec<&str> = body.lines().collect();
    let Some(h) = lines.iter().position(|l| super::store::cells(l, ',').first().is_some_and(|c| c.eq_ignore_ascii_case("date"))) else { return Vec::new() };
    let head: Vec<Option<f64>> = super::store::cells(lines[h], ',').iter().map(|c| c.strip_suffix('Y').and_then(|n| n.parse().ok())).collect();
    let mut out = Vec::new();
    for l in &lines[h + 1..] {
        let c = super::store::cells(l, ',');
        let Some(d) = c.first().and_then(|d| NaiveDate::parse_from_str(d, "%Y/%m/%d").ok()) else { continue };
        for (i, v) in c.iter().enumerate().skip(1) {
            if let (Some(Some(y)), Ok(x)) = (head.get(i), v.parse::<f64>()) {
                out.push(Point { years: *y, date: d.to_string(), value: x });
            }
        }
    }
    out
}

/// Bank of England IADB CSV (`CSVF=TN`): `DATE,IUDSNZC,...` then `02 Nov 2026,4.8059,...`; the declared `years` map names each code's maturity.
pub fn boe_iadb_csv(body: &str, src: &Value) -> Vec<Point> {
    let lines: Vec<&str> = body.lines().collect();
    let Some(h) = lines.iter().position(|l| super::store::cells(l, ',').first().is_some_and(|c| c.eq_ignore_ascii_case("date"))) else { return Vec::new() };
    let head: Vec<Option<f64>> = super::store::cells(lines[h], ',').iter().map(|c| src["years"].get(c.as_str()).and_then(Value::as_f64)).collect();
    let mut out = Vec::new();
    for l in &lines[h + 1..] {
        let c = super::store::cells(l, ',');
        let Some(d) = c.first().and_then(|d| NaiveDate::parse_from_str(d, "%d %b %Y").ok()) else { continue };
        for (i, v) in c.iter().enumerate().skip(1) {
            if let (Some(Some(y)), Ok(x)) = (head.get(i), v.parse::<f64>()) {
                out.push(Point { years: *y, date: d.to_string(), value: x });
            }
        }
    }
    out
}

/// ChinaBond `czbChartSearch`: `[{ycDefId, worktime: "2026-11-18", seriesData: [[years, yield], ...]}]`; the declared `curve_id` picks the curve.
pub fn chinabond_chart_json(body: &str, src: &Value) -> anyhow::Result<Vec<Point>> {
    let v: Value = serde_json::from_str(body.trim_start_matches('\u{feff}'))?;
    let want = src["curve_id"].as_str();
    let mut out = Vec::new();
    for c in v.as_array().into_iter().flatten() {
        if want.is_some_and(|w| c["ycDefId"].as_str() != Some(w)) {
            continue;
        }
        let Some(d) = c["worktime"].as_str().and_then(|d| NaiveDate::parse_from_str(d.get(..10).unwrap_or(d), "%Y-%m-%d").ok()) else { continue };
        for p in c["seriesData"].as_array().into_iter().flatten() {
            if let (Some(y), Some(x)) = (p.get(0).and_then(Value::as_f64), p.get(1).and_then(Value::as_f64)) {
                out.push(Point { years: y, date: d.to_string(), value: x });
            }
        }
    }
    Ok(out)
}

/// The text of every `<td>` in order (tags inside a cell dropped, whitespace collapsed).
fn tds(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(i) = rest.find("<td") {
        let after = &rest[i..];
        let Some(gt) = after.find('>') else { break };
        let body = &after[gt + 1..];
        let end = body.find("</td>").unwrap_or(body.len());
        let mut t = String::new();
        let mut in_tag = false;
        for ch in body[..end].chars() {
            match ch {
                '<' => in_tag = true,
                '>' => in_tag = false,
                c if !in_tag => t.push(c),
                _ => {}
            }
        }
        out.push(t.replace("&nbsp;", " ").split_whitespace().collect::<Vec<_>>().join(" "));
        rest = &body[end..];
    }
    out
}

/// ChinaBond `moreInfo` (the MOF-China curve's published key tenors): rows `Date | Maturity | Yield(%) | changes...`, the date cell spanning them.
pub fn chinabond_table_html(body: &str) -> Vec<Point> {
    let start = body.find("gjqxData").unwrap_or(0);
    let cells = tds(&body[start..]);
    let mut out = Vec::new();
    let mut day: Option<String> = None;
    let mut i = 0;
    while i < cells.len() {
        let c = cells[i].as_str();
        if let Ok(d) = NaiveDate::parse_from_str(c, "%Y-%m-%d") {
            day = Some(d.to_string());
        } else if let (Some(d), Some(y)) = (&day, maturity_label(c)) {
            if let Some(x) = cells.get(i + 1).and_then(|v| v.parse::<f64>().ok()) {
                out.push(Point { years: y, date: d.clone(), value: x });
                i += 1;
            }
        }
        i += 1;
    }
    out
}

/// `3Mo`, `6Mo`, `1Yr`, `10Yr` -> years.
fn maturity_label(s: &str) -> Option<f64> {
    if let Some(m) = s.strip_suffix("Mo") {
        return m.trim().parse::<f64>().ok().map(|v| v / 12.0);
    }
    s.strip_suffix("Yr").and_then(|y| y.trim().parse::<f64>().ok())
}

/// Bank of England `latest-yield-curve-data.zip`: the declared member (`GLC Nominal daily data current month.xlsx`), its declared sheet
/// (`4. spot curve`): a header row of maturities in years (0.5 .. 40), then one row per business day, column A an Excel serial date.
pub fn boe_glc_zip(body: &[u8], src: &Value) -> anyhow::Result<Vec<Point>> {
    let member = src["member"].as_str().unwrap_or("GLC Nominal daily data current month.xlsx");
    let xlsx = unzip(body, member)?;
    let sheet = src["sheet"].as_str().unwrap_or("4. spot curve");
    let wb = String::from_utf8_lossy(&unzip(&xlsx, "xl/workbook.xml")?).into_owned();
    let rels = String::from_utf8_lossy(&unzip(&xlsx, "xl/_rels/workbook.xml.rels")?).into_owned();
    let rid = elements(&wb, "sheet").into_iter().find(|t| attr(t, "name").as_deref() == Some(sheet)).and_then(|t| attr(&t, "r:id"));
    let Some(rid) = rid else { anyhow::bail!("the workbook has no sheet {sheet:?}") };
    let target = elements(&rels, "Relationship").into_iter().find(|t| attr(t, "Id").as_deref() == Some(rid.as_str())).and_then(|t| attr(&t, "Target"));
    let Some(target) = target else { anyhow::bail!("the workbook names no part for {rid}") };
    let path = match target.strip_prefix('/') {
        Some(abs) => abs.to_string(),
        None => format!("xl/{target}"),
    };
    let xml = String::from_utf8_lossy(&unzip(&xlsx, &path)?).into_owned();
    Ok(glc_sheet(&xml))
}

/// The spot-curve sheet's points (see `boe_glc_zip`).
pub fn glc_sheet(xml: &str) -> Vec<Point> {
    let rows = sheet_rows(xml);
    let mut head: Option<HashMap<String, f64>> = None;
    let mut out = Vec::new();
    let epoch = NaiveDate::from_ymd_opt(1899, 12, 30).expect("excel epoch");
    for r in rows {
        let a = r.iter().find(|c| c.col == "A");
        let a_num = a.filter(|c| c.t.is_empty()).and_then(|c| c.v.parse::<f64>().ok());
        let nums: HashMap<String, f64> = r.iter().filter(|c| c.col != "A" && c.t.is_empty()).filter_map(|c| c.v.parse::<f64>().ok().map(|v| (c.col.clone(), v))).collect();
        match (&head, a_num) {
            // the header: column A a label, the rest maturities
            (None, None) if nums.len() >= 5 => head = Some(nums),
            (Some(h), Some(serial)) if serial > 20_000.0 && serial < 80_000.0 => {
                let d = (epoch + Days::days(serial.floor() as i64)).to_string();
                for (col, v) in nums {
                    if let Some(y) = h.get(&col) {
                        out.push(Point { years: *y, date: d.clone(), value: v });
                    }
                }
            }
            _ => {}
        }
    }
    out
}

struct XCell {
    col: String,
    t: String,
    v: String,
}

/// The cells of every `<row>` of a worksheet: column letters, type attribute, `<v>` text.
fn sheet_rows(xml: &str) -> Vec<Vec<XCell>> {
    let mut rows = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find("<row") {
        let after = &rest[i + 4..];
        let Some(gt) = after.find('>') else { break };
        if after[..gt].ends_with('/') {
            rest = &after[gt + 1..];
            continue;
        }
        let body = &after[gt + 1..];
        let end = body.find("</row>").unwrap_or(body.len());
        let row = &body[..end];
        let mut cells = Vec::new();
        let mut r = row;
        while let Some(j) = r.find("<c ") {
            let c = &r[j..];
            let Some(g) = c.find('>') else { break };
            let tag = &c[..g];
            let col: String = attr(tag, "r").unwrap_or_default().chars().take_while(|ch| ch.is_ascii_alphabetic()).collect();
            let t = attr(tag, "t").unwrap_or_default();
            let (v, next) = if tag.ends_with('/') {
                (String::new(), g + 1)
            } else {
                let close = c.find("</c>").unwrap_or(c.len());
                let inner = &c[g + 1..close];
                let v = inner.find("<v>").and_then(|a| inner[a + 3..].find("</v>").map(|b| inner[a + 3..a + 3 + b].to_string())).unwrap_or_default();
                (v, (close + 4).min(c.len()))
            };
            cells.push(XCell { col, t, v });
            r = &c[next..];
        }
        rows.push(cells);
        rest = &body[end..];
    }
    rows
}

/// Every start tag `<name ...>` (its text up to `>`).
fn elements(xml: &str, name: &str) -> Vec<String> {
    let open = format!("<{name} ");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find(&open) {
        let after = &rest[i..];
        let end = after.find('>').unwrap_or(after.len());
        out.push(after[..end].to_string());
        rest = &after[end..];
    }
    out
}

/// An attribute of a start tag, XML entities decoded; ` name="` so `r` does not match `r:id`.
fn attr(tag: &str, name: &str) -> Option<String> {
    let key = format!(" {name}=\"");
    let i = tag.find(&key)? + key.len();
    let j = tag[i..].find('"')?;
    Some(tag[i..i + j].replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&"))
}

const MAX_MEMBER: usize = 64 << 20;

fn u16le(b: &[u8], i: usize) -> anyhow::Result<usize> {
    b.get(i..i + 2).map(|x| u16::from_le_bytes([x[0], x[1]]) as usize).ok_or_else(|| anyhow::anyhow!("truncated zip"))
}

fn u32le(b: &[u8], i: usize) -> anyhow::Result<usize> {
    b.get(i..i + 4).map(|x| u32::from_le_bytes([x[0], x[1], x[2], x[3]]) as usize).ok_or_else(|| anyhow::anyhow!("truncated zip"))
}

/// One member of a zip archive (stored or deflated; found through the central directory, so a data descriptor is fine).
pub fn unzip(data: &[u8], want: &str) -> anyhow::Result<Vec<u8>> {
    let lo = data.len().saturating_sub(65_557);
    let eocd = (lo..data.len().saturating_sub(21)).rev().find(|&i| data[i..i + 4] == [0x50, 0x4b, 0x05, 0x06]).ok_or_else(|| anyhow::anyhow!("not a zip archive"))?;
    let entries = u16le(data, eocd + 10)?;
    let mut p = u32le(data, eocd + 16)?;
    for _ in 0..entries {
        if data.get(p..p + 4) != Some(&[0x50, 0x4b, 0x01, 0x02][..]) {
            anyhow::bail!("bad zip central directory");
        }
        let method = u16le(data, p + 10)?;
        let csize = u32le(data, p + 20)?;
        let usize_ = u32le(data, p + 24)?;
        let (n, e, k) = (u16le(data, p + 28)?, u16le(data, p + 30)?, u16le(data, p + 32)?);
        let off = u32le(data, p + 42)?;
        let name = data.get(p + 46..p + 46 + n).ok_or_else(|| anyhow::anyhow!("truncated zip"))?;
        if name == want.as_bytes() {
            if data.get(off..off + 4) != Some(&[0x50, 0x4b, 0x03, 0x04][..]) {
                anyhow::bail!("bad zip local header");
            }
            let start = off + 30 + u16le(data, off + 26)? + u16le(data, off + 28)?;
            let raw = data.get(start..start + csize).ok_or_else(|| anyhow::anyhow!("truncated zip member"))?;
            if usize_ > MAX_MEMBER {
                anyhow::bail!("zip member too large");
            }
            return match method {
                0 => Ok(raw.to_vec()),
                8 => {
                    let mut out = Vec::with_capacity(usize_);
                    flate2::read::DeflateDecoder::new(raw).take(MAX_MEMBER as u64).read_to_end(&mut out)?;
                    Ok(out)
                }
                m => anyhow::bail!("zip compression method {m} unsupported"),
            };
        }
        p += 46 + n + e + k;
    }
    anyhow::bail!("the archive has no {want:?}")
}

// ---------------------------------------------------------------- fetch + cache

/// A source's address with its slots filled (`{from_dmy}`: today minus `lookback_days`, `02/Nov/2026`).
pub fn source_url(src: &Value, day: NaiveDate) -> String {
    let from = day - Days::days(src["lookback_days"].as_i64().unwrap_or(20));
    src["url"].as_str().unwrap_or_default().replace("{from_dmy}", &from.format("%d/%b/%Y").to_string())
}

/// https only; plain http only to the loopback (the tests' recorded-answer server).
fn allowed(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://127.0.0.1:")
}

async fn fetch(client: &reqwest::Client, src: &Value) -> anyhow::Result<Vec<u8>> {
    let url = source_url(src, super::today());
    if !allowed(&url) {
        anyhow::bail!("refusing a non-https source address");
    }
    let rq = if src["method"].as_str() == Some("POST") { client.post(&url).header("Content-Length", "0").body("") } else { client.get(&url) };
    let r = rq.header("Accept", "application/json, text/csv, application/zip, text/html, */*").send().await.map_err(|e| anyhow::anyhow!("{}", e.without_url()))?;
    if !r.status().is_success() {
        anyhow::bail!("answered {}", r.status().as_u16());
    }
    Ok(r.bytes().await.map_err(|e| anyhow::anyhow!("{}", e.without_url()))?.to_vec())
}

/// The country's sources in order; the first that parses wins. Err: every source's reason.
async fn fetch_country(client: &reqwest::Client, sources: &[Value]) -> Result<Entry, String> {
    let mut why = Vec::new();
    for s in sources {
        let id = s["id"].as_str().unwrap_or_default();
        match fetch(client, s).await.and_then(|b| parse(s["format"].as_str().unwrap_or_default(), &b, s)) {
            Ok(points) => {
                let now = chrono::Utc::now().timestamp();
                return Ok(Entry {
                    points,
                    source: id.to_string(),
                    name: s["name"].as_str().unwrap_or_default().to_string(),
                    licence: s["licence"].as_str().unwrap_or_default().to_string(),
                    fetched_at: now,
                    tried_at: now,
                    error: None,
                });
            }
            Err(e) => {
                tracing::warn!(source = id, error = %e, "sovereign curves: source failed");
                why.push(format!("{id}: {e}"));
            }
        }
    }
    Err(if why.is_empty() { "no source declared".into() } else { why.join("; ") })
}

/// A country's entry: the cache while fresh (or while a failure waits `retry_s`), else a refresh; Err when there was never an answer.
pub async fn country(s: &AppState, cc: &str) -> Result<(Entry, bool), String> {
    let sv = &s.finterm.sovereign;
    let Some(slot) = sv.slots.get(cc) else { return Err(format!("no free sovereign curve source declared for {cc}")) };
    let mut g = slot.lock().await;
    let now = chrono::Utc::now().timestamp();
    let pool = s.finterm.store.get();
    if g.is_none() {
        if let Some(p) = pool {
            let v: Option<String> = sqlx::query_scalar("SELECT value FROM fin_doc WHERE id = ?1").bind(format!("sovereign:{cc}")).fetch_optional(p).await.ok().flatten();
            *g = v.and_then(|v| serde_json::from_str::<Entry>(&v).ok());
        }
    }
    let ttl = sv.ttl();
    if let Some(e) = g.as_ref() {
        let fresh = now - e.fetched_at < ttl;
        let waiting = e.error.is_some() && now - e.tried_at < sv.retry();
        if fresh || waiting {
            return if e.points.is_empty() { Err(e.error.clone().unwrap_or_default()) } else { Ok((e.clone(), !fresh)) };
        }
    }
    let sources = sv.decl["countries"][cc].as_array().cloned().unwrap_or_default();
    match fetch_country(&s.finterm.client, &sources).await {
        Ok(e) => {
            if let Some(p) = pool {
                if let Ok(v) = serde_json::to_value(&e) {
                    let _ = super::store::put_doc(p, &format!("sovereign:{cc}"), &v).await;
                }
            }
            *g = Some(e.clone());
            Ok((e, false))
        }
        Err(why) => {
            let mut e = g.take().unwrap_or_default();
            e.tried_at = now;
            e.error = Some(why.clone());
            *g = Some(e.clone());
            if e.points.is_empty() {
                Err(why)
            } else {
                Ok((e, true))
            }
        }
    }
}

pub fn router() -> Router<AppState> {
    let route = serde_json::from_str::<Value>(DECL_JSON).ok().and_then(|d| d["route"].as_str().map(str::to_string)).unwrap_or_else(|| "/v1/rates/sovereign-curves".into());
    Router::new().route(&route, get(sovereign_curves))
}

fn list(q: &HashMap<String, String>, k: &str, default: &Value) -> Vec<String> {
    match q.get(k) {
        Some(v) => v.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
        None => default.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect(),
    }
}

fn bad(msg: String) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg, "source": "finterm" }))).into_response()
}

/// `GET /v1/rates/sovereign-curves?countries=GB,JP,CN&tenors=2,5,10,30`:
/// `{as_of, generated_at, tenors, curves: {CC: {tenor: {value, date, source}}}, unavailable: {CC: reason}, meta: {CC: {...}}}`.
async fn sovereign_curves(State(s): State<AppState>, Query(q): Query<HashMap<String, String>>) -> Response {
    let decl = &s.finterm.sovereign.decl;
    let countries: Vec<String> = list(&q, "countries", &decl["default_countries"])
        .into_iter()
        .map(|c| {
            let u = c.to_ascii_uppercase();
            decl["aliases"].get(&u).and_then(Value::as_str).map(str::to_string).unwrap_or(u)
        })
        .fold(Vec::new(), |mut v, c| {
            if !v.contains(&c) {
                v.push(c);
            }
            v
        });
    let tenors = list(&q, "tenors", &decl["default_tenors"]);
    if countries.is_empty() || countries.len() > 20 {
        return bad("countries: 1 to 20 ISO 3166 alpha-2 codes, comma separated".into());
    }
    if tenors.is_empty() || tenors.len() > 30 {
        return bad("tenors: 1 to 30 maturities in years (2, 10, 0.5) or months (6M), comma separated".into());
    }
    let mut wanted = Vec::new();
    for t in &tenors {
        match tenor_years(t) {
            Some(y) => wanted.push((t.clone(), y)),
            None => return bad(format!("tenor {t:?} is not a maturity in years (2, 10, 0.5) or months (6M)")),
        }
    }
    let answers = futures::future::join_all(countries.iter().map(|cc| {
        let s = s.clone();
        let cc = cc.clone();
        async move {
            let r = if let Some(why) = decl_elsewhere(&s, &cc) { Err(why) } else { country(&s, &cc).await };
            (cc, r)
        }
    }))
    .await;
    let mut curves = Map::new();
    let mut unavailable = Map::new();
    let mut meta = Map::new();
    let mut as_of: Option<String> = None;
    let mut oldest: Option<i64> = None;
    let mut any_stale = false;
    let mut sources = Vec::new();
    for (cc, r) in answers {
        match r {
            Ok((e, stale)) => {
                let mut curve = Map::new();
                let mut missing = Vec::new();
                for (t, y) in &wanted {
                    match newest(&e.points, *y) {
                        Some(p) => {
                            if as_of.as_ref().is_none_or(|a| p.date > *a) {
                                as_of = Some(p.date.clone());
                            }
                            curve.insert(t.clone(), json!({ "value": p.value, "date": p.date, "source": e.source }));
                        }
                        None => missing.push(t.clone()),
                    }
                }
                if curve.is_empty() {
                    unavailable.insert(cc.clone(), json!(format!("{} publishes none of the tenors asked", e.source)));
                    continue;
                }
                any_stale |= stale;
                oldest = Some(oldest.map_or(e.fetched_at, |o| o.min(e.fetched_at)));
                if !sources.contains(&e.source) {
                    sources.push(e.source.clone());
                }
                let fetched = chrono::DateTime::from_timestamp(e.fetched_at, 0).map(|d| d.format("%Y-%m-%dT%H:%M:%SZ").to_string());
                let mut m = json!({ "source": e.source, "name": e.name, "licence": e.licence, "fetched_at": fetched, "stale": stale });
                if !missing.is_empty() {
                    m["missing_tenors"] = json!(missing);
                    m["missing_reason"] = json!(format!("{} does not publish these maturities", e.source));
                }
                if stale {
                    m["last_error"] = json!(e.error);
                }
                meta.insert(cc.clone(), m);
                curves.insert(cc, Value::Object(curve));
            }
            Err(why) => {
                unavailable.insert(cc, json!(why));
            }
        }
    }
    let ttl = s.finterm.sovereign.ttl();
    let generated_at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    if curves.is_empty() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "no answer yet for these sovereign curves", "source": "finterm", "unavailable": unavailable, "generated_at": generated_at })),
        )
            .into_response();
    }
    let mut h = HeaderMap::new();
    let mut put = |k: &'static str, v: String| {
        if let Ok(x) = HeaderValue::from_str(&v) {
            h.insert(k, x);
        }
    };
    put("cache-control", format!("public, max-age={}", ttl.clamp(60, 3600)));
    put("x-source", sources.join(","));
    if let Some(at) = oldest.and_then(|o| chrono::DateTime::from_timestamp(o, 0)) {
        put("x-fetched-at", at.format("%Y-%m-%dT%H:%M:%SZ").to_string());
    }
    if any_stale {
        put("x-stale", "true".into());
    }
    let body = json!({ "as_of": as_of, "generated_at": generated_at, "tenors": tenors, "curves": curves, "unavailable": unavailable, "meta": meta });
    (StatusCode::OK, h, Json(body)).into_response()
}

/// A country served by another /v1 route (US, EA) is pointed there; None for a declared or unknown one.
fn decl_elsewhere(s: &AppState, cc: &str) -> Option<String> {
    let d = &s.finterm.sovereign.decl;
    if d["countries"].get(cc).is_some() {
        return None;
    }
    d["elsewhere"].get(cc).and_then(Value::as_str).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    // the recorded file as served: its notice line is not UTF-8
    const MOF: &[u8] = include_bytes!("../../tests/fixtures/sovereign/mof_jgbcme.csv");
    const IADB: &str = include_str!("../../tests/fixtures/sovereign/boe_iadb_zc.csv");
    const GLC: &[u8] = include_bytes!("../../tests/fixtures/sovereign/boe_latest_yield_curve_data.zip");
    const CB_JSON: &str = include_str!("../../tests/fixtures/sovereign/chinabond_chart.json");
    const CB_HTML: &str = include_str!("../../tests/fixtures/sovereign/chinabond_moreinfo.html");

    fn decl() -> Value {
        serde_json::from_str(DECL_JSON).unwrap()
    }

    fn src(cc: &str, i: usize) -> Value {
        decl()["countries"][cc][i].clone()
    }

    fn at<'a>(p: &'a [Point], y: f64) -> &'a Point {
        newest(p, y).unwrap_or_else(|| panic!("no {y}y point"))
    }

    #[test]
    fn the_declaration_loads_and_every_format_has_a_parser() {
        let s = Sovereign::default();
        for cc in ["GB", "JP", "CN"] {
            assert!(s.slots.contains_key(cc), "{cc} declared");
            for x in s.decl["countries"][cc].as_array().unwrap() {
                assert!(x["url"].as_str().unwrap().starts_with("https://"), "{x}");
            }
        }
        assert!(Sovereign::from_json(r#"{"countries":{"XX":[{"id":"x","format":"nope","url":"https://h"}]}}"#).is_err());
    }

    #[test]
    fn tenors_parse_in_years_and_months() {
        assert_eq!(tenor_years("2"), Some(2.0));
        assert_eq!(tenor_years("10Y"), Some(10.0));
        assert_eq!(tenor_years("0.5"), Some(0.5));
        assert!((tenor_years("6m").unwrap() - 0.5).abs() < 1e-9);
        assert_eq!(tenor_years("x"), None);
        assert_eq!(tenor_years("-1"), None);
    }

    #[test]
    fn mof_jgb_current_month_csv() {
        let p = parse("mof_jgb_csv", MOF, &src("JP", 0)).unwrap();
        // newest day of the recorded file: 2026/11/17
        assert_eq!(at(&p, 2.0), &Point { years: 2.0, date: "2026-11-17".into(), value: 1.878 });
        assert_eq!(at(&p, 5.0).value, 2.274);
        assert_eq!(at(&p, 10.0).value, 2.925);
        assert_eq!(at(&p, 30.0).value, 4.069);
        assert!(p.iter().any(|x| x.date == "2026-11-02" && same_tenor(x.years, 10.0) && x.value == 2.817));
        // a `-` cell is no observation, and the notice line after the data is ignored
        let p = mof_jgb_csv("Interest Rate,,(Unit : %)\nDate,1Y,40Y\n1974/9/24,10.327,-\n,,\n\"note\",,\n");
        assert_eq!(p, vec![Point { years: 1.0, date: "1974-09-24".into(), value: 10.327 }]);
    }

    #[test]
    fn boe_glc_spot_curve_from_the_zipped_workbook() {
        let p = parse("boe_glc_zip", GLC, &src("GB", 0)).unwrap();
        // recorded rows: 2026-11-02 .. 2026-11-06 (Excel serials 46328 .. 46332)
        let two = at(&p, 2.0);
        assert_eq!(two.date, "2026-11-06");
        assert!((two.value - 4.5660880395048675).abs() < 1e-12);
        assert!((at(&p, 5.0).value - 4.7652125662686284).abs() < 1e-12);
        assert!((at(&p, 10.0).value - 5.1419214894746883).abs() < 1e-12);
        assert!((at(&p, 30.0).value - 5.6242651990915622).abs() < 1e-12);
        // the 10y spot on 2 Nov agrees with the IADB zero-coupon series (IUDMNZC 5.1815)
        let d2 = p.iter().find(|x| x.date == "2026-11-02" && same_tenor(x.years, 10.0)).unwrap();
        assert!((d2.value - 5.1815).abs() < 5e-5);
        assert!(boe_glc_zip(b"not a zip", &src("GB", 0)).is_err());
        let mut other = src("GB", 0);
        other["sheet"] = json!("9. no such sheet");
        assert!(boe_glc_zip(GLC, &other).is_err());
    }

    #[test]
    fn boe_iadb_zero_coupon_fallback() {
        let p = parse("boe_iadb_csv", IADB.as_bytes(), &src("GB", 1)).unwrap();
        assert!(newest(&p, 2.0).is_none(), "IADB has no 2y spot: left out, not made up");
        assert_eq!(at(&p, 5.0).date, "2026-11-16");
        assert!(p.iter().any(|x| x.date == "2026-11-02" && same_tenor(x.years, 10.0) && x.value == 5.1815));
        let u = source_url(&src("GB", 1), NaiveDate::from_ymd_opt(2026, 11, 18).unwrap());
        assert!(u.contains("Datefrom=29/Oct/2026"), "{u}");
    }

    #[test]
    fn chinabond_chart_json_and_table() {
        let p = parse("chinabond_chart_json", CB_JSON.as_bytes(), &src("CN", 0)).unwrap();
        assert_eq!(at(&p, 2.0), &Point { years: 2.0, date: "2026-11-18".into(), value: 1.2301 });
        assert_eq!(at(&p, 10.0).value, 1.5892);
        assert!(newest(&p, 30.0).is_some());
        // another curve id is not this curve
        let mut other = src("CN", 0);
        other["curve_id"] = json!("nope");
        assert!(parse("chinabond_chart_json", CB_JSON.as_bytes(), &other).is_err());
        let t = parse("chinabond_table_html", CB_HTML.as_bytes(), &src("CN", 1)).unwrap();
        assert_eq!(at(&t, 2.0), &Point { years: 2.0, date: "2026-11-18".into(), value: 1.23 });
        assert_eq!(at(&t, 5.0).value, 1.33);
        assert_eq!(at(&t, 10.0).value, 1.59);
        assert_eq!(at(&t, 30.0).value, 2.05);
        assert!((at(&t, 0.25).value - 1.17).abs() < 1e-9);
        // the two CN answers agree to the table's two decimals
        for y in [2.0, 5.0, 10.0, 30.0] {
            assert!((at(&p, y).value - at(&t, y).value).abs() < 0.006, "{y}y");
        }
    }

    #[test]
    fn garbage_parses_to_an_error_not_to_values() {
        for f in FORMATS {
            assert!(parse(f, b"<html>maintenance</html>", &Value::Null).is_err(), "{f}");
        }
    }
}
