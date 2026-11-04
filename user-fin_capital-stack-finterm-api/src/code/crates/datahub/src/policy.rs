//! Per-topic metadata (TTL, intervals, push-only). Ports `TopicPolicy` from
//! `fincept-qt/src/datahub/TopicPolicy.h`.

use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TopicPolicy {
    /// Cached value is considered fresh for this long.
    pub ttl: Duration,
    /// Scheduler refuses to refresh a topic more often than this.
    pub min_interval: Duration,
    /// True → scheduler never refreshes this topic. Producer pushes on its own
    /// cadence (WebSocket-driven topics).
    pub push_only: bool,
    /// Higher = refreshed first under scheduler backpressure.
    pub priority: i32,
    /// Publish coalescing window (for progressive publishes, §11.1).
    pub coalesce_within: Option<Duration>,
}

impl Default for TopicPolicy {
    fn default() -> Self {
        Self {
            ttl: Duration::from_millis(30_000),
            min_interval: Duration::from_millis(5_000),
            push_only: false,
            priority: 0,
            coalesce_within: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_spec() {
        let p = TopicPolicy::default();
        assert_eq!(p.ttl, Duration::from_millis(30_000));
        assert_eq!(p.min_interval, Duration::from_millis(5_000));
        assert!(!p.push_only);
    }
}
