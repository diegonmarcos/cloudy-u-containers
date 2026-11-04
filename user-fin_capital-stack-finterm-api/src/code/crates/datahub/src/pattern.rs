//! Topic pattern matcher. Per spec §3.1, `*` is allowed only at the tail:
//!
//!   `market:quote:*`     matches `market:quote:AAPL`
//!   `market:*`           matches `market:quote:AAPL` AND `market:history:AAPL`
//!
//! We keep this intentionally minimal — no `?`, no mid-string globs.

use std::fmt;

#[derive(Debug, Clone)]
pub struct TopicPattern {
    raw: String,
    prefix: String,
    is_wildcard: bool,
}

impl TopicPattern {
    /// Parse a pattern string. Accepts exact topics (`market:quote:AAPL`) and
    /// tail-wildcard patterns (`market:quote:*`, `market:*`).
    #[must_use]
    pub fn new(pattern: &str) -> Self {
        let pattern = pattern.to_string();
        if let Some(stripped) = pattern.strip_suffix('*') {
            Self {
                prefix: stripped.to_string(),
                raw: pattern,
                is_wildcard: true,
            }
        } else {
            Self {
                prefix: pattern.clone(),
                raw: pattern,
                is_wildcard: false,
            }
        }
    }

    #[must_use]
    pub fn is_wildcard(&self) -> bool {
        self.is_wildcard
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.raw
    }

    /// True if `topic` is matched by this pattern.
    #[must_use]
    pub fn matches(&self, topic: &str) -> bool {
        if self.is_wildcard {
            topic.starts_with(&self.prefix)
        } else {
            topic == self.prefix
        }
    }
}

impl fmt::Display for TopicPattern {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_match() {
        let p = TopicPattern::new("market:quote:AAPL");
        assert!(!p.is_wildcard());
        assert!(p.matches("market:quote:AAPL"));
        assert!(!p.matches("market:quote:TSLA"));
        assert!(!p.matches("market:quote:"));
    }

    #[test]
    fn wildcard_matches_prefix() {
        let p = TopicPattern::new("market:quote:*");
        assert!(p.is_wildcard());
        assert!(p.matches("market:quote:AAPL"));
        assert!(p.matches("market:quote:TSLA"));
        assert!(!p.matches("market:history:AAPL"));
    }

    #[test]
    fn wildcard_matches_multi_level() {
        let p = TopicPattern::new("market:*");
        assert!(p.matches("market:quote:AAPL"));
        assert!(p.matches("market:history:AAPL:1y:1d"));
        assert!(!p.matches("news:general"));
    }
}
