//! Event bus — imperative cross-module signalling (commands, UI triggers).
//!
//! Intentionally distinct from `fincept-datahub`. DataHub is for **data
//! state** (last-known-good values with TTL + scheduler). EventBus is for
//! **one-shot events** (user clicked refresh, agent run started, window
//! closed).
//!
//! Backed by `tokio::sync::broadcast` — receivers get messages from the
//! moment they subscribe (no replay).

use tokio::sync::broadcast;

pub struct EventBus<E: Clone + Send + 'static> {
    tx: broadcast::Sender<E>,
}

impl<E: Clone + Send + 'static> EventBus<E> {
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<E> {
        self.tx.subscribe()
    }

    pub fn publish(&self, event: E) -> Result<usize, broadcast::error::SendError<E>> {
        self.tx.send(event)
    }

    pub fn receiver_count(&self) -> usize {
        self.tx.receiver_count()
    }
}

impl<E: Clone + Send + 'static> Default for EventBus<E> {
    fn default() -> Self {
        Self::new(64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum TestEvt {
        Ping(u32),
    }

    #[tokio::test]
    async fn publish_reaches_subscribers() {
        let bus: EventBus<TestEvt> = EventBus::new(8);
        let mut rx = bus.subscribe();
        bus.publish(TestEvt::Ping(7)).unwrap();
        let got = rx.recv().await.unwrap();
        assert_eq!(got, TestEvt::Ping(7));
    }

    #[tokio::test]
    async fn no_receivers_fails_cleanly() {
        let bus: EventBus<TestEvt> = EventBus::new(8);
        let err = bus.publish(TestEvt::Ping(1));
        assert!(err.is_err());
    }
}
