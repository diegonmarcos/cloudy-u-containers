//! DataHub — in-process pub/sub.
//!
//! Port of `fincept-qt/src/datahub/` preserving the semantic contract from
//! `DATAHUB_ARCHITECTURE.md`:
//!
//! - Topic format: `domain:subdomain:id[:modifier]` (lowercase, colon-delim)
//! - Subscribers auto-clean on drop (replaces Qt's `QObject::destroyed` signal)
//! - Wildcard subscription via `domain:sub:*` (tail-only, lowercase)
//! - Producers own refresh logic for topic patterns they claim
//! - TopicPolicy governs TTL, min interval, push-only, priority
//! - `publish` is thread-safe; slots are invoked on the publisher's task
//! - `request` is in-flight-deduped
//! - Scheduler tick is explicit (`tick_scheduler`) — no internal timer here;
//!   the app wires a tokio `interval` to drive it (matches Qt `QTimer`)

mod hub;
mod pattern;
mod policy;
mod producer;
mod subscription;

pub use hub::{DataHub, TopicStats};
pub use pattern::TopicPattern;
pub use policy::TopicPolicy;
pub use producer::Producer;
pub use subscription::Subscription;

/// Every value that flows through the hub is a `serde_json::Value` wrapped in
/// `Arc` for zero-copy fan-out. Typed producers serialize their domain structs
/// via `serde`; subscribers deserialize on receive. Matches the semantic shape
/// of `QVariant` + `Q_DECLARE_METATYPE` without tying us to Qt's meta-type
/// system.
pub type Value = std::sync::Arc<serde_json::Value>;

/// Convenience: wrap a serializable value into a hub `Value`.
#[must_use]
pub fn value<T: serde::Serialize>(v: T) -> Value {
    std::sync::Arc::new(serde_json::to_value(v).expect("value serializable"))
}
