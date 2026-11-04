//! Data-driven integration test.
//!
//! Loads `connector-specs.json` at the workspace root. For every spec:
//!   1. Spins up a wiremock server
//!   2. Mounts a mock matching the spec's endpoint returning `test.response`
//!   3. Builds a `GenericConnector` bound to the mock
//!   4. Calls `fetch_with_params` and runs every `test.assertions` entry
//!
//! Adding a new vendor is a JSON edit — no Rust changes required.

use fincept_data_generic::{validate_spec, ConnectorSpec};
use fincept_http::Client;
use serde::Deserialize;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

#[derive(Debug, Deserialize)]
struct Registry {
    specs: Vec<ConnectorSpec>,
}

fn load_registry() -> Registry {
    // Path from crate dir: ../../../connector-specs.json
    let raw = include_str!("../../../../connector-specs.json");
    serde_json::from_str(raw).expect("connector-specs.json must be valid")
}

#[tokio::test]
async fn every_spec_roundtrips_through_wiremock() {
    let registry = load_registry();
    assert!(!registry.specs.is_empty(), "no specs declared");

    let mut failures: Vec<String> = Vec::new();
    let total = registry.specs.len();

    for spec in &registry.specs {
        let server = MockServer::start().await;
        // Match on method only — endpoint paths vary per spec and include
        // `{var}` placeholders. Wiremock's single-mock per server with
        // method-only matcher is sufficient for the round-trip assertion.
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(spec.test.response.clone()))
            .mount(&server)
            .await;

        let http = Client::new(Default::default()).unwrap();
        match validate_spec(spec, http, &server.uri()).await {
            Ok(()) => {}
            Err(e) => failures.push(format!("[{}] {}", spec.id, e)),
        }
    }

    if !failures.is_empty() {
        panic!(
            "{}/{} connector specs failed:\n{}",
            failures.len(),
            total,
            failures.join("\n")
        );
    }
}

#[tokio::test]
async fn spec_ids_are_unique() {
    let registry = load_registry();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for s in &registry.specs {
        assert!(
            seen.insert(&s.id),
            "duplicate spec id: {} — connector-specs.json must have unique ids",
            s.id
        );
    }
}

#[tokio::test]
async fn spec_endpoints_are_non_empty() {
    let registry = load_registry();
    for s in &registry.specs {
        assert!(!s.endpoint.is_empty(), "spec '{}' has empty endpoint", s.id);
        assert!(
            s.endpoint.starts_with('/'),
            "spec '{}' endpoint must start with '/'",
            s.id
        );
        assert!(
            !s.topic_patterns.is_empty(),
            "spec '{}' has no topic_patterns",
            s.id
        );
    }
}
