//! Producer trait — port of `fincept-qt/src/datahub/Producer.h`.

use crate::pattern::TopicPattern;

/// A service that owns refresh for a set of topic patterns.
///
/// The hub calls `refresh` when at least one subscriber exists for a topic the
/// producer claims AND the cached value is stale per `TopicPolicy`.
///
/// Implementations must be `Send + Sync` since the hub may call them from its
/// scheduler task.
pub trait Producer: Send + Sync {
    /// Patterns this producer owns, e.g. `["market:quote:*", "market:history:*"]`.
    fn topic_patterns(&self) -> Vec<TopicPattern>;

    /// Hub calls this when ≥1 subscriber exists and the cached value is stale.
    /// Producer is free to batch further; it publishes back via the hub.
    fn refresh(&self, topics: &[String]);

    /// Optional: max outbound requests per second (0 = unlimited).
    fn max_requests_per_sec(&self) -> u32 {
        0
    }

    /// Called when the last subscriber leaves a topic. Producer may release
    /// resources (close WebSocket, cancel stream, etc.).
    fn on_topic_idle(&self, _topic: &str) {}
}
