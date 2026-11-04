//! Port of `fincept-qt/tests/datahub/test_datahub.cpp` (9 cases).
//!
//! Behavioural differences between Qt and Rust:
//! - Qt `subscribe` returns QMetaObject::Connection, auto-cancels via
//!   `QObject::destroyed`. Here `subscribe` returns `Subscription`;
//!   dropping it cancels. Lifetime guard is expressed with block scope.
//! - Qt uses `QTRY_COMPARE` to pump the event loop for queued slots. Our
//!   callbacks are invoked synchronously on `publish`, so we assert directly.
//! - `QThread::create(...).wait()` → `std::thread::spawn(...).join()`.

use fincept_datahub::{value, DataHub, Producer, TopicPattern, TopicPolicy};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

// ── Test helpers ─────────────────────────────────────────────────────────────

/// Recording producer — mirrors the Qt helper in test_datahub.cpp.
struct RecordingProducer {
    patterns: Vec<TopicPattern>,
    rps: u32,
    refresh_count: AtomicUsize,
    last_refresh_topics: Mutex<Vec<String>>,
    all_requested_topics: Mutex<Vec<String>>,
    idle_topics: Mutex<Vec<String>>,
}

impl RecordingProducer {
    fn new(patterns: &[&str]) -> Arc<Self> {
        Self::with_rps(patterns, 0)
    }
    fn with_rps(patterns: &[&str], rps: u32) -> Arc<Self> {
        Arc::new(Self {
            patterns: patterns.iter().map(|p| TopicPattern::new(p)).collect(),
            rps,
            refresh_count: AtomicUsize::new(0),
            last_refresh_topics: Mutex::new(Vec::new()),
            all_requested_topics: Mutex::new(Vec::new()),
            idle_topics: Mutex::new(Vec::new()),
        })
    }

    fn refresh_count(&self) -> usize {
        self.refresh_count.load(Ordering::Relaxed)
    }
}

impl Producer for RecordingProducer {
    fn topic_patterns(&self) -> Vec<TopicPattern> {
        self.patterns.clone()
    }
    fn max_requests_per_sec(&self) -> u32 {
        self.rps
    }
    fn refresh(&self, topics: &[String]) {
        self.refresh_count.fetch_add(1, Ordering::Relaxed);
        *self.last_refresh_topics.lock() = topics.to_vec();
        self.all_requested_topics.lock().extend_from_slice(topics);
    }
    fn on_topic_idle(&self, topic: &str) {
        self.idle_topics.lock().push(topic.to_string());
    }
}

// ── 1/9 ──────────────────────────────────────────────────────────────────────

#[test]
fn subscribe_publish_delivers() {
    let hub = DataHub::new();
    let received: Arc<Mutex<Option<i64>>> = Arc::new(Mutex::new(None));
    let r = received.clone();
    let _sub = hub.subscribe("test:basic:1", move |v| {
        *r.lock() = v.as_i64();
    });
    hub.publish("test:basic:1", value(42));
    assert_eq!(*received.lock(), Some(42));
}

// ── 2/9 ──────────────────────────────────────────────────────────────────────

#[test]
fn subscribe_receives_initial_value() {
    let hub = DataHub::new();
    hub.publish("test:initial:1", value("hello"));

    let received: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let r = received.clone();
    let _sub = hub.subscribe("test:initial:1", move |v| {
        *r.lock() = v.as_str().map(str::to_string);
    });
    assert_eq!(received.lock().as_deref(), Some("hello"));
}

// ── 3/9 ──────────────────────────────────────────────────────────────────────

#[test]
fn destroyed_owner_auto_unsubscribes() {
    let hub = DataHub::new();
    let call_count = Arc::new(AtomicUsize::new(0));

    {
        let cc = call_count.clone();
        let _sub = hub.subscribe("test:destroy:1", move |_| {
            cc.fetch_add(1, Ordering::Relaxed);
        });
        hub.publish("test:destroy:1", value(1));
        assert_eq!(call_count.load(Ordering::Relaxed), 1);
    } // _sub dropped here — auto-unsubscribe

    hub.publish("test:destroy:1", value(2));
    assert_eq!(call_count.load(Ordering::Relaxed), 1);

    // Subscriber count for this topic should have dropped to 0.
    for s in hub.stats() {
        if s.topic == "test:destroy:1" {
            assert_eq!(s.subscriber_count, 0);
        }
    }
}

// ── 4/9 ──────────────────────────────────────────────────────────────────────

#[test]
fn wildcard_pattern_matches() {
    let hub = DataHub::new();
    let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    let _sub = hub.subscribe_pattern("test:wild:*", move |t, _| {
        s.lock().push(t.to_string());
    });

    hub.publish("test:wild:alpha", value(1));
    hub.publish("test:wild:beta", value(2));
    hub.publish("test:other:gamma", value(3));

    let got = seen.lock();
    assert_eq!(got.len(), 2);
    assert!(got.contains(&"test:wild:alpha".to_string()));
    assert!(got.contains(&"test:wild:beta".to_string()));
    assert!(!got.contains(&"test:other:gamma".to_string()));
}

// ── 5/9 ──────────────────────────────────────────────────────────────────────

#[test]
fn push_only_skips_scheduler() {
    let hub = DataHub::new();
    let prod = RecordingProducer::new(&["test:push:*"]);
    hub.register_producer(prod.clone());

    let p = TopicPolicy {
        push_only: true,
        ..Default::default()
    };
    hub.set_policy_pattern("test:push:*", p);

    let _sub = hub.subscribe("test:push:live", |_| {});

    for _ in 0..5 {
        hub.tick_scheduler();
    }
    assert_eq!(prod.refresh_count(), 0);
}

// ── 6/9 ──────────────────────────────────────────────────────────────────────

#[test]
fn request_dedups_in_flight() {
    let hub = DataHub::new();
    let prod = RecordingProducer::new(&["test:flight:*"]);
    hub.register_producer(prod.clone());

    // Set policy with min_interval=0 so the second request is gated ONLY by
    // the in-flight check, matching the C++ test's intent.
    let p = TopicPolicy {
        min_interval: std::time::Duration::from_millis(0),
        ..Default::default()
    };
    hub.set_policy_pattern("test:flight:*", p);

    let _sub = hub.subscribe("test:flight:1", |_| {});

    hub.request("test:flight:1", false);
    hub.request("test:flight:1", false); // deduped — already in flight
    assert_eq!(prod.refresh_count(), 1);

    // Once the producer publishes, in-flight clears and next request fires.
    hub.publish("test:flight:1", value(1));
    hub.request("test:flight:1", false);
    assert_eq!(prod.refresh_count(), 2);
}

// ── 7/9 ──────────────────────────────────────────────────────────────────────

#[test]
fn cross_thread_publish_marshals() {
    let hub = DataHub::new();
    let received = Arc::new(AtomicUsize::new(0));
    let r = received.clone();
    let _sub = hub.subscribe("test:xthread:1", move |v| {
        r.store(v.as_u64().unwrap_or(0) as usize, Ordering::Relaxed);
    });

    let hub_worker = hub.clone();
    let worker = std::thread::spawn(move || {
        hub_worker.publish("test:xthread:1", value(77_u64));
    });
    worker.join().expect("worker panicked");
    assert_eq!(received.load(Ordering::Relaxed), 77);
}

// ── 8/9 ──────────────────────────────────────────────────────────────────────

#[test]
fn peek_reads_without_subscribing() {
    let hub = DataHub::new();
    assert!(hub.peek("test:peek:unset").is_none());
    hub.publish("test:peek:set", value("seeded"));
    assert_eq!(
        hub.peek("test:peek:set")
            .and_then(|v| v.as_str().map(str::to_string)),
        Some("seeded".into())
    );
    // Peek creates no subscriber.
    for s in hub.stats() {
        if s.topic == "test:peek:set" {
            assert_eq!(s.subscriber_count, 0);
        }
    }
}

// ── 9/9 ──────────────────────────────────────────────────────────────────────

#[test]
fn scheduler_respects_ttl() {
    let hub = DataHub::new();
    let prod = RecordingProducer::new(&["test:ttl:*"]);
    hub.register_producer(prod.clone());

    let p = TopicPolicy {
        ttl: std::time::Duration::from_secs(60),
        min_interval: std::time::Duration::from_millis(0),
        ..Default::default()
    };
    hub.set_policy_pattern("test:ttl:*", p);

    let _sub = hub.subscribe("test:ttl:1", |_| {});

    // First tick: no cached value → refresh fires.
    hub.tick_scheduler();
    assert_eq!(prod.refresh_count(), 1);

    // Producer publishes. TTL is 60 s so next tick must skip.
    hub.publish("test:ttl:1", value(1));
    hub.tick_scheduler();
    assert_eq!(prod.refresh_count(), 1);
}
