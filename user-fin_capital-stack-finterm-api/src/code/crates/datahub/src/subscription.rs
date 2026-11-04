//! RAII subscription handle. Dropping the handle removes the subscription
//! from the hub — this replaces the Qt `QObject::destroyed` auto-cleanup.

use crate::hub::{DataHub, SubscriberId};
use std::sync::Weak;

/// Handle returned by `DataHub::subscribe` / `subscribe_pattern`.
/// Keep it alive to receive callbacks; drop it to unsubscribe.
pub struct Subscription {
    pub(crate) id: SubscriberId,
    pub(crate) hub: Weak<DataHub>,
}

impl Subscription {
    /// Explicitly drop the subscription. Equivalent to `drop(sub)` but clearer
    /// at call sites.
    pub fn cancel(self) {
        drop(self);
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(hub) = self.hub.upgrade() {
            hub.unsubscribe_by_id(self.id);
        }
    }
}
