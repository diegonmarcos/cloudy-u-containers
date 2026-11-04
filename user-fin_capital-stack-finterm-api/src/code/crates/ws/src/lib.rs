//! WebSocket client — minimal facade over `tokio-tungstenite`. Producers
//! (Kraken, HyperLiquid, Polymarket, broker ticks) wrap this and publish into
//! DataHub on every message.

use thiserror::Error;
pub use tokio_tungstenite::tungstenite::Message;

/// Errors from this crate. The tungstenite error is boxed because it's 136 B
/// and we want `Result<T, Error>` to stay 2 pointers wide on the hot path.
#[derive(Debug, Error)]
pub enum Error {
    #[error("invalid ws url: {0}")]
    InvalidUrl(String),
    #[error("ws: {0}")]
    Ws(#[from] Box<tokio_tungstenite::tungstenite::Error>),
}

impl From<tokio_tungstenite::tungstenite::Error> for Error {
    fn from(e: tokio_tungstenite::tungstenite::Error) -> Self {
        Self::Ws(Box::new(e))
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Stable URL validation — returns `Ok(())` if the string parses as a ws://
/// or wss:// URL. Phase 2+ adds the actual connect helpers.
pub fn validate_url(url: &str) -> Result<()> {
    if !(url.starts_with("ws://") || url.starts_with("wss://")) {
        return Err(Error::InvalidUrl(url.to_string()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_ws_urls() {
        assert!(validate_url("wss://ws.kraken.com/v2").is_ok());
        assert!(validate_url("ws://localhost:9001").is_ok());
        assert!(validate_url("https://ws.kraken.com/v2").is_err());
        assert!(validate_url("").is_err());
    }
}
