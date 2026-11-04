//! Shared primitives for fincept-rs.
//!
//! Phase 0 scaffold. Real content lands in Phase 1 alongside DataHub.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("config error: {0}")]
    Config(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("serde error: {0}")]
    Serde(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

pub fn ok_unit() -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ok_unit_is_ok() {
        assert!(ok_unit().is_ok());
    }

    #[test]
    fn error_displays() {
        let e = Error::Config("missing".into());
        assert_eq!(e.to_string(), "config error: missing");
    }
}
