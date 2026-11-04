//! FinTerm aggregator (#1351, design 3.3): the fetch jobs GENERATED from the FinTerm app's declarations
//! (`src/code/fetchers.json`, written by `src/fetchers/gen-fetchers.mjs`, DO NOT EDIT), run on each source's declared
//! schedule, normalised into the one model the APK and the web read (`normalise.rs`), published on DataHub topics
//! `finterm:job:<id>` and served under `/v1` (`routes.rs`). No provider address is typed in Rust: every endpoint,
//! path and parameter comes from fetchers.json.

pub mod normalise;
pub mod routes;
pub mod scheduler;
pub mod freestack;
pub mod fxmatrix;
pub mod g20bonds;
pub mod store;

use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// The generated job list, embedded at build time.
pub const FETCHERS_JSON: &str = include_str!("../../../../fetchers.json");

/// One declared fetch job (fetchers.json `jobs[]`).
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct Job {
    pub id: String,
    pub source: String,
    pub connector: String,
    pub endpoint: String,
    pub path: String,
    #[serde(default)]
    pub params: serde_json::Map<String, Value>,
    #[serde(default)]
    pub items: Vec<String>,
    pub ttl_s: u64,
    #[serde(default)]
    pub per_min: Option<u64>,
    #[serde(default)]
    pub per_day: Option<u64>,
    #[serde(default)]
    pub opts: Value,
    #[serde(default)]
    pub serves: Vec<String>,
    #[serde(default)]
    pub paths: Value,
    #[serde(default)]
    pub attribution: String,
}

/// The state of a job, reported by `/v1/catalog`.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct JobStatus {
    pub id: String,
    pub source: String,
    pub status: String,
    pub last_ok: Option<String>,
    pub last_error: Option<String>,
    pub runs: u64,
}

/// The FinTerm side of the server state.
pub struct Finterm {
    pub declaration_sha: String,
    pub v1: String,
    pub jobs: Vec<Job>,
    pub declared: Value,
    pub status: Mutex<HashMap<String, JobStatus>>,
    pub client: reqwest::Client,
    /// The market store's declaration (fetchers.json `declared["universe.json"]`, from the app's data/universe.json).
    pub universe: Value,
    /// The market store (FINTERM_DB), set once by `store::start`; unset when the server runs without a database.
    pub store: OnceLock<sqlx::SqlitePool>,
}

impl Finterm {
    pub fn from_embedded() -> anyhow::Result<Self> {
        Self::from_json(FETCHERS_JSON)
    }

    pub fn from_json(text: &str) -> anyhow::Result<Self> {
        let doc: Value = serde_json::from_str(text)?;
        let jobs: Vec<Job> = serde_json::from_value(doc.get("jobs").cloned().unwrap_or(Value::Array(vec![])))?;
        for j in &jobs {
            if !normalise::CONNECTORS.contains(&j.connector.as_str()) {
                anyhow::bail!("fetchers.json job {} names connector {} that normalise.rs does not implement", j.id, j.connector);
            }
        }
        let status = jobs
            .iter()
            .map(|j| (j.id.clone(), JobStatus { id: j.id.clone(), source: j.source.clone(), status: "pending".into(), ..Default::default() }))
            .collect();
        // SEC asks for a contact in the User-Agent: the generic fleet contact declared in universe.json free_stack.contact (#1416,
        // a role mailbox, nothing personal), or the deployment's FINTERM_CONTACT. Our own name, never a browser's.
        let contact = std::env::var("FINTERM_CONTACT").ok().filter(|c| !c.trim().is_empty()).unwrap_or_else(|| {
            doc.pointer("/declared/universe.json/free_stack/contact").and_then(Value::as_str).unwrap_or_default().to_string()
        });
        let ua = format!("Capital-Stack-FinTerminal/{} ({contact})", env!("CARGO_PKG_VERSION"));
        let client = reqwest::Client::builder().user_agent(ua).http1_only().timeout(std::time::Duration::from_secs(45)).build()?;
        Ok(Self {
            declaration_sha: doc.get("declaration_sha").and_then(Value::as_str).unwrap_or_default().to_string(),
            v1: doc.get("v1").and_then(Value::as_str).unwrap_or("/v1").to_string(),
            jobs,
            universe: doc.get("declared").and_then(|d| d.get("universe.json")).cloned().unwrap_or(Value::Null),
            declared: doc.get("declared").cloned().unwrap_or(Value::Null),
            status: Mutex::new(status),
            client,
            store: OnceLock::new(),
        })
    }

    /// The jobs that back a /v1 path (as fetchers.json `serves` writes it).
    pub fn serving<'a>(&'a self, path: &'a str) -> impl Iterator<Item = &'a Job> + 'a {
        self.jobs.iter().filter(move |j| j.serves.iter().any(|s| s == path))
    }

    pub fn topic(job_id: &str) -> String {
        format!("finterm:job:{job_id}")
    }
}

/// Today (UTC) as YYYY-MM-DD.
pub fn today() -> chrono::NaiveDate {
    chrono::Utc::now().date_naive()
}

/// The slots a declared path or parameter may carry (same set as the APK's Engine.slots and the guard's S7).
pub fn slots(job: &Job, day: chrono::NaiveDate) -> HashMap<&'static str, String> {
    use chrono::{Datelike, Duration};
    let lookback = job.opts.get("lookback_days").and_then(Value::as_i64).unwrap_or(7);
    let prev = day.with_day(1).unwrap_or(day) - Duration::days(1);
    let mut m = HashMap::new();
    m.insert("today", day.to_string());
    m.insert("from", (day - Duration::days(lookback)).to_string());
    m.insert("yyyymm", format!("{:04}{:02}", day.year(), day.month()));
    m.insert("prev_yyyymm", format!("{:04}{:02}", prev.year(), prev.month()));
    m.insert("cik", job.opts.get("cik").and_then(Value::as_str).unwrap_or_default().to_string());
    m.insert("each_csv", job.items.join(","));
    m
}

pub fn fill(s: &str, slots: &HashMap<&'static str, String>, each: &str) -> String {
    let mut out = s.replace("{each}", each);
    for (k, v) in slots {
        out = out.replace(&format!("{{{k}}}"), v);
    }
    out
}

/// endpoint + path + params (an array repeats its key, the order kept), every value percent-encoded; slots filled.
pub fn job_url(job: &Job, day: chrono::NaiveDate, each: &str) -> String {
    let sl = slots(job, day);
    let path = fill(&job.path, &sl, each);
    let mut q: Vec<String> = Vec::new();
    for (k, v) in &job.params {
        let vals: Vec<String> = match v {
            Value::Array(a) => a.iter().map(|x| x.as_str().map(str::to_string).unwrap_or_else(|| x.to_string())).collect(),
            Value::String(s) => vec![s.clone()],
            other => vec![other.to_string()],
        };
        for x in vals {
            q.push(format!("{}={}", enc(k), enc(&fill(&x, &sl, each))));
        }
    }
    let base = format!("{}{}", job.endpoint.trim_end_matches('/'), path);
    if q.is_empty() {
        base
    } else {
        format!("{}{}{}", base, if base.contains('?') { "&" } else { "?" }, q.join("&"))
    }
}

/// RFC 3986 unreserved characters pass, everything else is %XX (UTF-8 bytes).
pub fn enc(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(v: Value) -> Job {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn the_embedded_declaration_loads_and_every_job_has_a_parser() {
        let f = Finterm::from_embedded().unwrap();
        assert!(!f.jobs.is_empty());
        assert_eq!(f.declaration_sha.len(), 64);
        assert!(f.jobs.iter().all(|j| j.ttl_s >= 60));
        assert!(f.serving("/v1/calendar/economic").any(|j| j.connector == "ff_calendar"));
        assert!(f.declared.get("central-banks.json").is_some());
        assert!(f.universe["history"]["symbols"].as_array().map_or(0, Vec::len) >= 60, "the universe declares the EOD symbols");
        assert!(f.serving("/v1/calendar/earnings").all(|j| j.source != "nasdaq_calendar"), "no Nasdaq job");
    }

    #[test]
    fn an_unknown_connector_is_refused() {
        let bad = r#"{"jobs":[{"id":"x","source":"s","connector":"nope","endpoint":"https://h","path":"/","ttl_s":60}]}"#;
        assert!(Finterm::from_json(bad).is_err());
    }

    #[test]
    fn urls_fill_slots_repeat_array_keys_and_encode() {
        let day = chrono::NaiveDate::from_ymd_opt(2026, 11, 2).unwrap();
        let j = job(serde_json::json!({"id":"t","source":"s","connector":"treasury_xml","endpoint":"https://h.test/p/","path":"/xml",
            "params":{"data":"curve","month":"{prev_yyyymm}","geo":["EA","DE"],"q":"a b,c"},"ttl_s":60}));
        // the key order follows serde_json's map (sorted, or declared with preserve_order): every pair is there once, encoded
        let u = job_url(&j, day, "");
        assert!(u.starts_with("https://h.test/p/xml?"), "{u}");
        let mut q: Vec<&str> = u.split_once('?').unwrap().1.split('&').collect();
        q.sort_unstable();
        assert_eq!(q, vec!["data=curve", "geo=DE", "geo=EA", "month=202610", "q=a%20b%2Cc"]);
        assert!(u.find("geo=EA").unwrap() < u.find("geo=DE").unwrap(), "an array keeps its order");
        let e = job(serde_json::json!({"id":"e","source":"s","connector":"cboe_quotes","endpoint":"https://h","path":"/quotes/{each}.json","ttl_s":60,"opts":{"lookback_days":3}}));
        assert_eq!(job_url(&e, day, "_SPX"), "https://h/quotes/_SPX.json");
        assert_eq!(slots(&e, day)["from"], "2026-10-30");
        assert_eq!(slots(&e, day)["yyyymm"], "202611");
    }
}
