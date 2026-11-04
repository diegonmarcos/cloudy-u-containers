//! Spec-driven generic connector.
//!
//! Phase 3 goal: let new vendors come online by adding a JSON spec, not by
//! writing a new crate. Each spec declares base URL, endpoint template,
//! query params, topic patterns, and a self-contained test fixture. This
//! module interprets the spec and implements `Connector` against it.
//!
//! The spec format is the single source of truth — see
//! `connector-specs.json` at workspace root.

use async_trait::async_trait;
use fincept_data_core::{Connector, ConnectorError, Result, TopicPattern};
use fincept_http::Client;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

// ── Spec types ───────────────────────────────────────────────────────────────

/// A single connector declaration. Edit `connector-specs.json` to add more.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorSpec {
    pub id: String,
    pub description: String,
    pub base_url: String,
    /// Endpoint path with `{name}` placeholders resolved by `path_params`.
    pub endpoint: String,
    pub topic_patterns: Vec<String>,
    #[serde(default)]
    pub query: BTreeMap<String, String>,
    #[serde(default)]
    pub max_requests_per_sec: u32,
    pub test: TestFixture,
}

/// Inline, hermetic golden-file test fixture carried by each spec.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestFixture {
    /// Values substituted into `{name}` placeholders of `endpoint`.
    #[serde(default)]
    pub path_params: BTreeMap<String, String>,
    /// Mock HTTP response body.
    pub response: serde_json::Value,
    /// List of (JSON pointer, expected value) assertions against the raw
    /// response. The generic connector returns the raw payload — domain
    /// reshaping is explicit per vendor (Phase 4+ topic-typed producers).
    pub assertions: Vec<Assertion>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Assertion {
    /// RFC-6901 JSON pointer, e.g. `/data/0/symbol`.
    pub pointer: String,
    pub expected: serde_json::Value,
}

// ── Connector impl ───────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct GenericConnector {
    http: Client,
    spec: ConnectorSpec,
    /// Overrides `spec.base_url` in tests (wiremock uri).
    base_url_override: Option<String>,
}

impl GenericConnector {
    pub fn new(http: Client, spec: ConnectorSpec) -> Self {
        Self {
            http,
            spec,
            base_url_override: None,
        }
    }

    #[must_use]
    pub fn with_base_url(mut self, base: impl Into<String>) -> Self {
        self.base_url_override = Some(base.into());
        self
    }

    fn base_url(&self) -> &str {
        self.base_url_override
            .as_deref()
            .unwrap_or(&self.spec.base_url)
    }

    /// Interpolate `{name}` placeholders in the endpoint template from `params`.
    /// Unknown placeholders survive untouched (useful for optional segments).
    fn interpolate(template: &str, params: &BTreeMap<String, String>) -> String {
        let mut out = template.to_string();
        for (k, v) in params {
            out = out.replace(&format!("{{{k}}}"), v);
        }
        out
    }

    fn build_url(&self, path_params: &BTreeMap<String, String>) -> String {
        let path = Self::interpolate(&self.spec.endpoint, path_params);
        let mut url = format!("{}{}", self.base_url(), path);
        if !self.spec.query.is_empty() {
            url.push('?');
            let parts: Vec<String> = self
                .spec
                .query
                .iter()
                .map(|(k, v)| {
                    format!(
                        "{}={}",
                        urlencode(k),
                        urlencode(&Self::interpolate(v, path_params))
                    )
                })
                .collect();
            url.push_str(&parts.join("&"));
        }
        url
    }

    /// Fetch the raw response for this spec given runtime path params.
    pub async fn fetch_with_params(
        &self,
        path_params: &BTreeMap<String, String>,
    ) -> Result<serde_json::Value> {
        let url = self.build_url(path_params);
        let raw: serde_json::Value = self.http.get_json(&url).await?;
        Ok(raw)
    }
}

#[async_trait]
impl Connector for GenericConnector {
    type Query = BTreeMap<String, String>;

    fn id(&self) -> &'static str {
        // Spec IDs are owned strings; `Connector` trait requires &'static str.
        // We leak once per process — connector IDs are long-lived and few.
        Box::leak(self.spec.id.clone().into_boxed_str())
    }

    fn topic_patterns(&self) -> Vec<TopicPattern> {
        self.spec
            .topic_patterns
            .iter()
            .map(|s| TopicPattern::new(s))
            .collect()
    }

    fn max_requests_per_sec(&self) -> u32 {
        self.spec.max_requests_per_sec
    }

    async fn fetch(&self, query: &Self::Query) -> Result<serde_json::Value> {
        self.fetch_with_params(query).await
    }
}

// ── URL encoding (minimal, no external crate for ~15 lines) ──────────────────

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Run a single spec end-to-end against a supplied base URL (typically a
/// wiremock server uri). Returns the raw response and whether every assertion
/// passed. Extracted so both unit tests and the workspace-wide spec-driver
/// test use the same code path.
pub async fn validate_spec(spec: &ConnectorSpec, http: Client, base_url: &str) -> Result<()> {
    let c = GenericConnector::new(http, spec.clone()).with_base_url(base_url);
    let raw = c.fetch_with_params(&spec.test.path_params).await?;
    for a in &spec.test.assertions {
        let got = raw.pointer(&a.pointer).ok_or_else(|| {
            ConnectorError::Vendor(format!("spec '{}' missing pointer {}", spec.id, a.pointer))
        })?;
        if got != &a.expected {
            return Err(ConnectorError::Vendor(format!(
                "spec '{}' assertion failed at {}: expected {}, got {}",
                spec.id, a.pointer, a.expected, got
            )));
        }
    }
    Ok(())
}

// ── Unit tests for the interpolator + url builder ────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolates_path_params() {
        let mut p = BTreeMap::new();
        p.insert("country".to_string(), "US".to_string());
        p.insert("indicator".to_string(), "NY.GDP.MKTP.CD".to_string());
        let out = GenericConnector::interpolate("/v2/country/{country}/indicator/{indicator}", &p);
        assert_eq!(out, "/v2/country/US/indicator/NY.GDP.MKTP.CD");
    }

    #[test]
    fn urlencode_handles_special_chars() {
        assert_eq!(urlencode("hello world"), "hello%20world");
        assert_eq!(urlencode("NGDP_RPCH"), "NGDP_RPCH");
        assert_eq!(urlencode("a&b=c"), "a%26b%3Dc");
    }

    #[test]
    fn build_url_combines_path_and_query() {
        let spec = ConnectorSpec {
            id: "t".into(),
            description: "".into(),
            base_url: "http://api.test".into(),
            endpoint: "/path/{id}".into(),
            topic_patterns: vec!["t:*".into()],
            query: [("k".to_string(), "v".to_string())].into(),
            max_requests_per_sec: 0,
            test: TestFixture {
                path_params: Default::default(),
                response: serde_json::json!({}),
                assertions: vec![],
            },
        };
        let http = Client::new(Default::default()).unwrap();
        let c = GenericConnector::new(http, spec);
        let mut p = BTreeMap::new();
        p.insert("id".into(), "42".into());
        assert_eq!(c.build_url(&p), "http://api.test/path/42?k=v");
    }
}
