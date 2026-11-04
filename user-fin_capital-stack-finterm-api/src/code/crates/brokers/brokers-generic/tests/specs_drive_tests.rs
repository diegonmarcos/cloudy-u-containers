//! Data-driven broker round-trip. For every spec in broker-specs.json:
//! spin up a wiremock server that returns the fixture payloads for
//! positions + balance, then exercise those two endpoints through the
//! GenericBroker adapter.
//!
//! Phase 7b extends this to place/get/cancel order, once the engine
//! supports endpoint-specific fixtures.

use fincept_brokers_generic::{validate_spec, BrokerSpec};
use fincept_http::Client;
use serde::Deserialize;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

#[derive(Debug, Deserialize)]
struct Registry {
    specs: Vec<BrokerSpec>,
}

fn load_registry() -> Registry {
    let raw = include_str!("../../../../broker-specs.json");
    serde_json::from_str(raw).expect("broker-specs.json must be valid")
}

#[tokio::test]
async fn every_spec_positions_and_balance_work() {
    let reg = load_registry();
    assert!(!reg.specs.is_empty());

    let mut failures = Vec::new();
    for spec in &reg.specs {
        let server = MockServer::start().await;
        // First GET on the server returns positions_response, second returns
        // balance_response. Wiremock respects priority: mount balance first
        // so its matcher fires when the URL contains the balance path.
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(spec.test.positions_response.clone()),
            )
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(spec.test.balance_response.clone()),
            )
            .mount(&server)
            .await;

        let http = Client::new(Default::default()).unwrap();
        if let Err(e) = validate_spec(spec, http, &server.uri()).await {
            failures.push(format!("[{}] {}", spec.id, e));
        }
    }
    assert!(
        failures.is_empty(),
        "{}/{} broker specs failed:\n{}",
        failures.len(),
        reg.specs.len(),
        failures.join("\n")
    );
}

#[tokio::test]
async fn spec_ids_are_unique() {
    let reg = load_registry();
    let mut seen = std::collections::HashSet::new();
    for s in &reg.specs {
        assert!(seen.insert(s.id.clone()), "duplicate spec id: {}", s.id);
    }
}
