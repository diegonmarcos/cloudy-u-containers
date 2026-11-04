//! Runs every declared job on its source's schedule (fetchers.json `ttl_s`), spacing per-item requests by the
//! source's `per_min`, and publishes the normalised answer on `finterm:job:<id>` as
//! `{got, fetched_at, job}`. A failed run keeps the last good value (served with `X-Stale`). When FINTERM_DB names a
//! SQLite file, every good answer is kept there too and restored at start, so `/v1` answers before the first fetch.
//! No auto-restart: a panic in a job ends that job's task only, and is visible in `/v1/catalog`.

use super::normalise::{self, Got};
use super::{job_url, today, Finterm, Job};
use crate::state::AppState;
use fincept_datahub::value;
use serde_json::{json, Value};
use std::time::Duration;

/// Restore the last-good answers, then spawn one task per job (staggered 2 s apart so a cold start is not a burst).
pub async fn start(state: AppState) {
    let db = match std::env::var("FINTERM_DB") {
        Ok(path) if !path.trim().is_empty() => match fincept_storage::open(path.trim()).await {
            Ok(pool) => {
                if let Err(e) = fincept_storage::ensure_cache_table(&pool).await {
                    tracing::warn!(error = %e, "finterm: cache table unavailable");
                }
                restore(&state, &pool).await;
                // the market store (EOD history, yield matrix, GDP, FX, SEC earnings) shares the file
                super::store::start(state.clone(), pool.clone()).await;
                Some(pool)
            }
            Err(e) => {
                tracing::warn!(error = %e, "finterm: FINTERM_DB unavailable, running without the last-good cache");
                None
            }
        },
        _ => None,
    };
    for (i, job) in state.finterm.jobs.clone().into_iter().enumerate() {
        let st = state.clone();
        let db = db.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2 * i as u64)).await;
            let mut tick = tokio::time::interval(Duration::from_secs(job.ttl_s.max(60)));
            loop {
                tick.tick().await;
                run_and_publish(&st, &job, db.as_ref()).await;
            }
        });
    }
}

/// One run: fetch, normalise, publish, record the status; `true` when it produced data.
pub async fn run_and_publish(state: &AppState, job: &Job, db: Option<&sqlx::SqlitePool>) -> bool {
    let started = chrono::Utc::now();
    let result = run(&state.finterm, job).await;
    let at = started.format("%Y-%m-%dT%H:%M:%SZ").to_string();
    // the status guard is a std Mutex: it must be released before any await (the spawned future has to be Send)
    let payload = {
        let mut st = state.finterm.status.lock().expect("status lock");
        let entry = st.entry(job.id.clone()).or_default();
        entry.id = job.id.clone();
        entry.source = job.source.clone();
        entry.runs += 1;
        match result {
            Ok(got) if !got.is_empty() => {
                entry.status = "ok".into();
                entry.last_ok = Some(at.clone());
                entry.last_error = None;
                Some(json!({ "got": got, "fetched_at": at, "job": job.id, "source": job.source, "attribution": job.attribution }))
            }
            Ok(_) if job.source == "forexfactory" => {
                // the next-week file is not published yet: an empty week is a legitimate answer, not a failure
                entry.status = "ok".into();
                entry.last_ok = Some(at.clone());
                entry.last_error = None;
                None
            }
            Ok(_) => {
                entry.status = "empty".into();
                entry.last_error = Some(format!("{at}: the answer parsed to nothing"));
                None
            }
            Err(e) => {
                entry.status = if entry.last_ok.is_some() { "stale".into() } else { "error".into() };
                entry.last_error = Some(format!("{at}: {e}"));
                None
            }
        }
    };
    let Some(payload) = payload else { return false };
    state.hub.publish(&Finterm::topic(&job.id), value(payload.clone()));
    if let Some(pool) = db {
        let _ = sqlx::query("INSERT INTO cache (key, value, category, expires_at, created_at) VALUES (?1, ?2, 'finterm', NULL, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at")
            .bind(Finterm::topic(&job.id))
            .bind(payload.to_string().into_bytes())
            .bind(started.timestamp())
            .execute(pool)
            .await;
    }
    true
}

/// Fetch one job: one request, or one per item (`items`, or the next `each_days` dates), spaced by `per_min`.
pub async fn run(f: &Finterm, job: &Job) -> anyhow::Result<Got> {
    let day = today();
    let mut items: Vec<String> = job.items.clone();
    if let Some(n) = job.opts.get("each_days").and_then(Value::as_i64) {
        items = (0..n).map(|i| (day + chrono::Duration::days(i)).to_string()).collect();
    }
    let per_item = !items.is_empty() && (job.path.contains("{each}") || job.params.values().any(|v| v.to_string().contains("{each}")));
    let list: Vec<String> = if per_item { items } else { vec![String::new()] };
    let gap = job.per_min.filter(|n| *n > 0).map(|n| Duration::from_millis(60_000 / n)).unwrap_or(Duration::ZERO);
    let mut got = Got::default();
    let mut errors = Vec::new();
    for (i, item) in list.iter().enumerate() {
        if i > 0 && !gap.is_zero() {
            tokio::time::sleep(gap).await;
        }
        match body(f, job, day, item).await {
            Ok(text) => got.extend(normalise::parse(&job.connector, &text, &job.opts, item, &job.paths)),
            Err(e) => errors.push(e.to_string()),
        }
    }
    if errors.len() == list.len() {
        anyhow::bail!("{}", errors.first().cloned().unwrap_or_default());
    }
    Ok(got)
}

/// The answer's text: a declared data file (endpoint "asset:") from fetchers.json `declared`, else an HTTPS GET.
async fn body(f: &Finterm, job: &Job, day: chrono::NaiveDate, item: &str) -> anyhow::Result<String> {
    if job.endpoint == "asset:" {
        let doc = f.declared.get(&job.path).ok_or_else(|| anyhow::anyhow!("declared file {} missing", job.path))?;
        return Ok(doc.to_string());
    }
    let url = job_url(job, day, item);
    if !url.starts_with("https://") {
        anyhow::bail!("refusing a non-https source address");
    }
    // a transient transport failure is retried with a backoff before the run is recorded as failed
    let mut attempt = 0;
    let resp = loop {
        match f.client.get(&url).header("Accept", "application/json, application/xml, text/plain, */*").send().await {
            Ok(r) => break r,
            Err(e) if attempt < 2 => {
                tracing::debug!(error = %e, attempt, "finterm: fetch retry");
                tokio::time::sleep(Duration::from_secs(2 + 3 * attempt)).await;
                attempt += 1;
            }
            Err(e) => return Err(e.into()),
        }
    };
    let status = resp.status();
    if status.as_u16() == 404 && job.source == "forexfactory" {
        // The next-week file is published late in the week; before that the source answers 404, which is "nothing yet", not a failure.
        return Ok("[]".to_string());
    }
    if !status.is_success() {
        anyhow::bail!("{} answered {}", job.source, status.as_u16());
    }
    Ok(resp.text().await?)
}

/// Publish every kept answer (FINTERM_DB) so the API answers before the first fetch; served stale until refreshed.
async fn restore(state: &AppState, pool: &sqlx::SqlitePool) {
    let rows: Vec<(String, Vec<u8>)> = sqlx::query_as("SELECT key, value FROM cache WHERE category = 'finterm'").fetch_all(pool).await.unwrap_or_default();
    let n = rows.len();
    for (key, bytes) in rows {
        if let Ok(mut v) = serde_json::from_slice::<Value>(&bytes) {
            v["restored"] = Value::Bool(true);
            state.hub.publish(&key, value(v));
        }
    }
    tracing::info!(restored = n, "finterm: last-good answers restored");
}

/// The jobs' answers as one `Got` (and the oldest fetch time, and whether any is stale), for a /v1 handler.
pub fn collect<'a>(state: &AppState, jobs: impl Iterator<Item = &'a Job>) -> (Got, Option<String>, bool, Vec<String>) {
    let mut got = Got::default();
    let mut oldest: Option<String> = None;
    let mut stale = false;
    let mut sources = Vec::new();
    let status = state.finterm.status.lock().expect("status lock").clone();
    for job in jobs {
        let Some(v) = state.hub.peek(&Finterm::topic(&job.id)) else { continue };
        let Ok(g) = serde_json::from_value::<Got>(v.get("got").cloned().unwrap_or(Value::Null)) else { continue };
        got.extend(g);
        if let Some(at) = v.get("fetched_at").and_then(Value::as_str) {
            if oldest.as_deref().map_or(true, |o| at < o) {
                oldest = Some(at.to_string());
            }
        }
        let job_stale = v.get("restored").and_then(Value::as_bool).unwrap_or(false)
            || status.get(&job.id).map_or(false, |s| s.status == "stale");
        stale |= job_stale;
        if !sources.contains(&job.source) {
            sources.push(job.source.clone());
        }
    }
    (got, oldest, stale, sources)
}

/// Run a job now (admin refresh, or a fetch-through on a cold cache).
pub async fn refresh(state: &AppState, job_id: &str) -> bool {
    let job = state.finterm.jobs.iter().find(|j| j.id == job_id).cloned();
    match job {
        Some(j) => run_and_publish(state, &j, None).await,
        None => false,
    }
}

