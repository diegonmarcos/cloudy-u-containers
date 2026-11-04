//! Authentication primitives. Phase 1 scope: PIN verify + session expiry model.
//! Biometric / OAuth providers land in Phase 7 alongside broker flows.

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("pin must be 4–10 digits, got {0} chars")]
    InvalidPin(usize),
    #[error("session expired")]
    SessionExpired,
}

pub type Result<T> = std::result::Result<T, Error>;

/// Very small PIN sanity check (length + digit-only). Real hashing will land
/// in Phase 7 — this is the Phase 1 shape so downstream code can depend on
/// the public API.
pub fn validate_pin(pin: &str) -> Result<()> {
    let len = pin.chars().count();
    if !(4..=10).contains(&len) || !pin.chars().all(|c| c.is_ascii_digit()) {
        return Err(Error::InvalidPin(len));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub user_id: String,
    pub issued_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

impl Session {
    #[must_use]
    pub fn new(user_id: impl Into<String>, ttl: Duration) -> Self {
        let issued_at = Utc::now();
        Self {
            user_id: user_id.into(),
            issued_at,
            expires_at: issued_at + ttl,
        }
    }

    pub fn check(&self, now: DateTime<Utc>) -> Result<()> {
        if now >= self.expires_at {
            Err(Error::SessionExpired)
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_length_bounds() {
        assert!(validate_pin("1234").is_ok());
        assert!(validate_pin("1234567890").is_ok());
        assert!(matches!(validate_pin("123"), Err(Error::InvalidPin(3))));
        assert!(matches!(validate_pin(""), Err(Error::InvalidPin(0))));
    }

    #[test]
    fn pin_rejects_non_digits() {
        assert!(matches!(validate_pin("12ab"), Err(Error::InvalidPin(_))));
    }

    #[test]
    fn session_expiry_works() {
        let s = Session::new("me", Duration::seconds(30));
        assert!(s.check(Utc::now()).is_ok());
        assert!(s.check(s.expires_at + Duration::seconds(1)).is_err());
    }
}
