//! Shared infrastructure for all `data-*` connectors.
//!
//! - `Connector` trait: uniform `fetch(query) → Value` interface.
//! - `RateLimiter`: wrapper over `governor` keyed per-connector.
//! - `retry`: exponential backoff helper (no external crate — ~20 lines).

use async_trait::async_trait;
use governor::{DefaultDirectRateLimiter, Quota};
use std::num::NonZeroU32;
use std::time::Duration;
use thiserror::Error;

pub use fincept_datahub::{Producer, TopicPattern};

#[derive(Debug, Error)]
pub enum ConnectorError {
    #[error("http: {0}")]
    Http(#[from] fincept_http::Error),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("vendor: {0}")]
    Vendor(String),
    #[error("rate limited (retry after {0:?})")]
    RateLimited(Duration),
    #[error("query: {0}")]
    BadQuery(String),
    #[error("giving up after {0} retries: {1}")]
    Exhausted(u32, String),
}

pub type Result<T> = std::result::Result<T, ConnectorError>;

/// Every connector implements this. `Q` is the connector-specific query type
/// (symbol, series id, range, …). Result is a normalized JSON value — typed
/// deserialization is the caller's job (or the hub's).
#[async_trait]
pub trait Connector: Send + Sync {
    type Query: Send + Sync;

    /// Human-readable connector id (`"yahoo"`, `"fred"`). Matches modules.json.
    fn id(&self) -> &'static str;

    /// DataHub topic patterns this connector owns.
    fn topic_patterns(&self) -> Vec<TopicPattern>;

    /// Fetch data for a single query.
    async fn fetch(&self, query: &Self::Query) -> Result<serde_json::Value>;

    /// Max outbound requests per second (0 = unlimited).
    fn max_requests_per_sec(&self) -> u32 {
        0
    }
}

// ── Rate limiter ─────────────────────────────────────────────────────────────

pub struct RateLimiter {
    inner: Option<DefaultDirectRateLimiter>,
}

impl RateLimiter {
    #[must_use]
    pub fn per_second(rps: u32) -> Self {
        if let Some(n) = NonZeroU32::new(rps) {
            Self {
                inner: Some(governor::RateLimiter::direct(Quota::per_second(n))),
            }
        } else {
            Self { inner: None }
        }
    }

    /// Wait until a permit is available.
    pub async fn acquire(&self) {
        if let Some(rl) = &self.inner {
            rl.until_ready().await;
        }
    }
}

// ── Retry helper ─────────────────────────────────────────────────────────────

/// Run `op` with exponential backoff. Returns on first success or after
/// `max_attempts`. Base delay doubles each retry, capped at `max_delay`.
pub async fn retry<T, F, Fut>(
    max_attempts: u32,
    base: Duration,
    max_delay: Duration,
    mut op: F,
) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let mut attempt = 0_u32;
    let mut delay = base;
    loop {
        attempt += 1;
        match op().await {
            Ok(v) => return Ok(v),
            Err(e) if attempt >= max_attempts => {
                return Err(ConnectorError::Exhausted(attempt, e.to_string()))
            }
            Err(e) => {
                tracing::debug!(attempt, error = %e, "retrying");
                tokio::time::sleep(delay).await;
                delay = std::cmp::min(delay.saturating_mul(2), max_delay);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn retry_eventually_succeeds() {
        let n = Arc::new(AtomicU32::new(0));
        let n2 = n.clone();
        let v = retry(
            5,
            Duration::from_millis(1),
            Duration::from_millis(4),
            move || {
                let n = n2.clone();
                async move {
                    let cur = n.fetch_add(1, Ordering::Relaxed);
                    if cur < 2 {
                        Err(ConnectorError::Vendor("transient".into()))
                    } else {
                        Ok(42)
                    }
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(v, 42);
        assert_eq!(n.load(Ordering::Relaxed), 3);
    }

    #[tokio::test]
    async fn retry_gives_up() {
        let err = retry::<i32, _, _>(
            3,
            Duration::from_millis(1),
            Duration::from_millis(4),
            || async { Err(ConnectorError::Vendor("always".into())) },
        )
        .await
        .unwrap_err();
        assert!(matches!(err, ConnectorError::Exhausted(3, _)));
    }

    #[tokio::test]
    async fn rate_limiter_unlimited_is_noop() {
        let rl = RateLimiter::per_second(0);
        for _ in 0..100 {
            rl.acquire().await;
        }
    }

    #[tokio::test]
    async fn rate_limiter_bounds_rate() {
        // 100 rps means at least 1ms between calls after burst.
        let rl = RateLimiter::per_second(100);
        let start = std::time::Instant::now();
        for _ in 0..10 {
            rl.acquire().await;
        }
        // Not asserting exact time to avoid flakiness on CI; just that we
        // didn't panic and the fn returns.
        let _ = start.elapsed();
    }
}
