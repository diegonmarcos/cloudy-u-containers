//! Core pub/sub registry, scheduler, and dispatcher.

use crate::pattern::TopicPattern;
use crate::policy::TopicPolicy;
use crate::producer::Producer;
use crate::subscription::Subscription;
use crate::Value;

use dashmap::DashMap;
use parking_lot::RwLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
use tracing::{debug, trace, warn};

pub type SubscriberId = u64;

type ExactCb = Arc<dyn Fn(&Value) + Send + Sync + 'static>;
type PatternCb = Arc<dyn Fn(&str, &Value) + Send + Sync + 'static>;

struct ExactSubscriber {
    id: SubscriberId,
    cb: ExactCb,
}

struct PatternSubscriber {
    id: SubscriberId,
    pattern: TopicPattern,
    cb: PatternCb,
}

struct CachedEntry {
    value: Value,
    published_at: Instant,
}

#[derive(Debug, Clone)]
pub struct TopicStats {
    pub topic: String,
    pub subscriber_count: usize,
    pub last_publish: Option<Instant>,
    pub last_refresh_request: Option<Instant>,
    pub total_publishes: u64,
    pub in_flight: bool,
}

/// The central pub/sub hub. Clone-safe via `Arc` — all handles share state.
///
/// In production the app owns one `Arc<DataHub>` and wires a tokio interval
/// that calls `tick_scheduler()` every second (matches Qt's 1 s `QTimer`).
pub struct DataHub {
    exact_subs: DashMap<String, Vec<ExactSubscriber>>,
    pattern_subs: RwLock<Vec<PatternSubscriber>>,
    cache: DashMap<String, CachedEntry>,
    /// Exact-topic policies override pattern policies.
    exact_policies: DashMap<String, TopicPolicy>,
    /// Pattern policies, evaluated in insertion order on miss.
    pattern_policies: RwLock<Vec<(TopicPattern, TopicPolicy)>>,
    producers: RwLock<Vec<Arc<dyn Producer>>>,
    in_flight: DashMap<String, Instant>,
    last_refresh_request: DashMap<String, Instant>,
    total_publishes: DashMap<String, u64>,
    next_id: AtomicU64,
    self_weak: RwLock<Weak<DataHub>>,
}

impl DataHub {
    /// Build a new hub. Returns an `Arc<Self>` because `Subscription` holds a
    /// `Weak<DataHub>` for auto-unsubscribe on drop.
    #[must_use]
    pub fn new() -> Arc<Self> {
        let hub = Arc::new(Self {
            exact_subs: DashMap::new(),
            pattern_subs: RwLock::new(Vec::new()),
            cache: DashMap::new(),
            exact_policies: DashMap::new(),
            pattern_policies: RwLock::new(Vec::new()),
            producers: RwLock::new(Vec::new()),
            in_flight: DashMap::new(),
            last_refresh_request: DashMap::new(),
            total_publishes: DashMap::new(),
            next_id: AtomicU64::new(1),
            self_weak: RwLock::new(Weak::new()),
        });
        *hub.self_weak.write() = Arc::downgrade(&hub);
        hub
    }

    fn weak(&self) -> Weak<DataHub> {
        self.self_weak.read().clone()
    }

    fn next_id(&self) -> SubscriberId {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    // ── Subscribing ───────────────────────────────────────────────────────────

    /// Subscribe to an exact topic. Returns a `Subscription`; drop it to cancel.
    ///
    /// If the topic has a cached value that is still fresh per policy, the
    /// callback is invoked synchronously with that value before this returns
    /// (matches §5.1 "subscriber receives current value immediately on subscribe").
    pub fn subscribe<F>(&self, topic: &str, callback: F) -> Subscription
    where
        F: Fn(&Value) + Send + Sync + 'static,
    {
        let id = self.next_id();
        let cb: ExactCb = Arc::new(callback);

        let was_idle = !self.exact_subs.contains_key(topic);
        self.exact_subs
            .entry(topic.to_string())
            .or_default()
            .push(ExactSubscriber { id, cb: cb.clone() });

        if was_idle {
            trace!(topic, "topic_active (first subscriber)");
        }

        // Immediate delivery of cached value if fresh.
        if let Some(cached) = self.cache.get(topic) {
            let policy = self.policy_for(topic);
            if cached.published_at.elapsed() <= policy.ttl {
                cb(&cached.value);
            }
        }

        Subscription {
            id,
            hub: self.weak(),
        }
    }

    /// Subscribe to a wildcard pattern. Callback receives `(topic, value)`.
    pub fn subscribe_pattern<F>(&self, pattern: &str, callback: F) -> Subscription
    where
        F: Fn(&str, &Value) + Send + Sync + 'static,
    {
        let id = self.next_id();
        let pat = TopicPattern::new(pattern);
        let cb: PatternCb = Arc::new(callback);
        self.pattern_subs.write().push(PatternSubscriber {
            id,
            pattern: pat,
            cb,
        });
        Subscription {
            id,
            hub: self.weak(),
        }
    }

    pub(crate) fn unsubscribe_by_id(&self, id: SubscriberId) {
        // Exact topic subscribers: walk shards; keep this in one scan.
        let mut empty_topics: Vec<String> = Vec::new();
        self.exact_subs.retain(|topic, subs| {
            subs.retain(|s| s.id != id);
            if subs.is_empty() {
                empty_topics.push(topic.clone());
                false
            } else {
                true
            }
        });
        // Pattern subscribers
        self.pattern_subs.write().retain(|s| s.id != id);

        for t in empty_topics {
            trace!(topic = %t, "topic_idle (last subscriber left)");
            let producers = self.producers.read();
            for p in producers.iter() {
                if self.producer_owns(p.as_ref(), &t) {
                    p.on_topic_idle(&t);
                }
            }
        }
    }

    // ── Publishing ────────────────────────────────────────────────────────────

    /// Store in cache (per topic policy TTL), fan out to all matching
    /// subscribers, clear in-flight marker. Thread-safe.
    pub fn publish(&self, topic: &str, value: Value) {
        self.cache.insert(
            topic.to_string(),
            CachedEntry {
                value: value.clone(),
                published_at: Instant::now(),
            },
        );
        self.in_flight.remove(topic);
        *self.total_publishes.entry(topic.to_string()).or_insert(0) += 1;

        // Exact subscribers
        if let Some(subs) = self.exact_subs.get(topic) {
            for s in subs.iter() {
                (s.cb)(&value);
            }
        }
        // Pattern subscribers
        let patterns = self.pattern_subs.read();
        for s in patterns.iter() {
            if s.pattern.matches(topic) {
                (s.cb)(topic, &value);
            }
        }
    }

    // ── Registration ──────────────────────────────────────────────────────────

    pub fn register_producer(&self, producer: Arc<dyn Producer>) {
        self.producers.write().push(producer);
    }

    pub fn unregister_producer(&self, producer: &Arc<dyn Producer>) {
        self.producers.write().retain(|p| !Arc::ptr_eq(p, producer));
    }

    pub fn set_policy(&self, topic: &str, policy: TopicPolicy) {
        self.exact_policies.insert(topic.to_string(), policy);
    }

    pub fn set_policy_pattern(&self, pattern: &str, policy: TopicPolicy) {
        self.pattern_policies
            .write()
            .push((TopicPattern::new(pattern), policy));
    }

    fn policy_for(&self, topic: &str) -> TopicPolicy {
        if let Some(p) = self.exact_policies.get(topic) {
            return *p;
        }
        let patterns = self.pattern_policies.read();
        // Last match wins, matching the Qt behaviour where later `set_policy_pattern`
        // calls override earlier ones.
        for (pat, policy) in patterns.iter().rev() {
            if pat.matches(topic) {
                return *policy;
            }
        }
        TopicPolicy::default()
    }

    // ── Pull-through ──────────────────────────────────────────────────────────

    /// Read the cached value without subscribing. Returns `None` if unknown.
    /// Does NOT trigger a fetch (matches §4 `peek`).
    #[must_use]
    pub fn peek(&self, topic: &str) -> Option<Value> {
        self.cache.get(topic).map(|e| e.value.clone())
    }

    /// Ask the hub to refresh this topic now.
    ///
    /// `force=false` (default): respects `min_interval_ms` — requests inside
    ///                          the interval are dropped.
    /// `force=true`: bypasses min_interval (user-driven refresh button).
    ///
    /// In-flight dedup: back-to-back requests before the producer publishes
    /// only trigger one `refresh()` call.
    pub fn request(&self, topic: &str, force: bool) {
        if self.in_flight.contains_key(topic) {
            trace!(topic, "request: already in flight, deduped");
            return;
        }

        if !force {
            let policy = self.policy_for(topic);
            if let Some(last) = self.last_refresh_request.get(topic) {
                if last.elapsed() < policy.min_interval {
                    trace!(topic, "request: inside min_interval, skipped");
                    return;
                }
            }
        }

        let producers = self.producers.read();
        let Some(producer) = producers
            .iter()
            .find(|p| self.producer_owns(p.as_ref(), topic))
        else {
            warn!(topic, "request: no producer registered");
            return;
        };

        self.in_flight.insert(topic.to_string(), Instant::now());
        self.last_refresh_request
            .insert(topic.to_string(), Instant::now());
        producer.refresh(&[topic.to_string()]);
    }

    pub fn request_many(&self, topics: &[String], force: bool) {
        for t in topics {
            self.request(t, force);
        }
    }

    fn producer_owns(&self, producer: &dyn Producer, topic: &str) -> bool {
        producer
            .topic_patterns()
            .iter()
            .any(|pat| pat.matches(topic))
    }

    // ── Scheduler ─────────────────────────────────────────────────────────────

    /// Single scheduler tick. The app drives this at ~1 Hz via a tokio
    /// interval (Qt's `QTimer` equivalent). Groups stale topics by producer
    /// and calls `refresh()` on each.
    pub fn tick_scheduler(&self) {
        // Collect topics that currently have ≥1 subscriber.
        let mut active_topics: Vec<String> = self
            .exact_subs
            .iter()
            .filter(|e| !e.value().is_empty())
            .map(|e| e.key().clone())
            .collect();

        // Also consider topics with only pattern subscribers that map to a
        // concrete topic via the cache (topics that have been published at
        // least once). Pattern-only topics with no prior publish cannot be
        // refreshed — we don't know the literal key.
        for entry in self.cache.iter() {
            let topic = entry.key();
            if active_topics.contains(topic) {
                continue;
            }
            let has_pattern_sub = self
                .pattern_subs
                .read()
                .iter()
                .any(|s| s.pattern.matches(topic));
            if has_pattern_sub {
                active_topics.push(topic.clone());
            }
        }

        let producers = self.producers.read();
        for topic in &active_topics {
            let policy = self.policy_for(topic);
            if policy.push_only {
                continue;
            }
            if self.in_flight.contains_key(topic) {
                continue;
            }
            // Fresh? skip.
            if let Some(cached) = self.cache.get(topic) {
                if cached.published_at.elapsed() <= policy.ttl {
                    continue;
                }
            }

            // Find producer and call refresh.
            if let Some(producer) = producers
                .iter()
                .find(|p| self.producer_owns(p.as_ref(), topic))
            {
                self.in_flight.insert(topic.clone(), Instant::now());
                producer.refresh(std::slice::from_ref(topic));
            } else {
                debug!(topic, "tick: stale but no producer");
            }
        }
    }

    // ── Stats ────────────────────────────────────────────────────────────────

    #[must_use]
    pub fn stats(&self) -> Vec<TopicStats> {
        let mut out: Vec<TopicStats> = Vec::new();
        // Union of topics seen across exact_subs and cache
        let mut topics: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for e in self.exact_subs.iter() {
            topics.insert(e.key().clone());
        }
        for e in self.cache.iter() {
            topics.insert(e.key().clone());
        }

        for topic in topics {
            let subscriber_count = self.exact_subs.get(&topic).map(|v| v.len()).unwrap_or(0);
            let last_publish = self.cache.get(&topic).map(|e| e.published_at);
            let last_refresh_request = self.last_refresh_request.get(&topic).map(|e| *e);
            let total_publishes = self.total_publishes.get(&topic).map(|v| *v).unwrap_or(0);
            let in_flight = self.in_flight.contains_key(&topic);
            out.push(TopicStats {
                topic,
                subscriber_count,
                last_publish,
                last_refresh_request,
                total_publishes,
                in_flight,
            });
        }
        out
    }
}

// Convenience: let callers probe freshness in tests without reimporting Duration.
#[doc(hidden)]
#[allow(dead_code)]
pub(crate) const fn default_ttl() -> Duration {
    Duration::from_millis(30_000)
}
