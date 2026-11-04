//! Full round-trip: fincept-client → fin-api over loopback.
//! Nothing mocked — this locks the REST contract between the two crates.

use fincept_client::{Client, StockMetrics};
use fin_api::{build_router, AppState};
use std::net::SocketAddr;
use tokio::net::TcpListener;

async fn spawn_server() -> String {
    let state = AppState::try_new().unwrap();
    let app = build_router(state);
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

#[tokio::test]
async fn health_round_trip() {
    let base = spawn_server().await;
    let c = Client::new(base);
    let h = c.health().await.unwrap();
    assert_eq!(h.status, "ok");
}

#[tokio::test]
async fn info_matches_fixture() {
    let base = spawn_server().await;
    let c = Client::new(base);
    let i = c.info().await.unwrap();
    assert_eq!(i.personas, 6);
    assert_eq!(i.mcp_tools, 5);
}

#[tokio::test]
async fn personas_round_trip() {
    let base = spawn_server().await;
    let c = Client::new(base);
    let ps = c.personas().await.unwrap();
    assert_eq!(ps.len(), 6);
    assert!(ps.iter().any(|p| p.id == "buffett"));
}

#[tokio::test]
async fn score_round_trip() {
    let base = spawn_server().await;
    let c = Client::new(base);
    let out = c
        .score(
            "buffett",
            StockMetrics {
                symbol: "AAPL".into(),
                pe_ratio: 12.0,
                roe: 0.25,
                debt_to_equity: 0.3,
                fcf_yield: 0.08,
                moat_score: 0.9,
            },
        )
        .await
        .unwrap();
    assert_eq!(out.symbol, "AAPL");
    assert!(out.score > 70.0);
}

#[tokio::test]
async fn publish_and_peek_round_trip() {
    let base = spawn_server().await;
    let c = Client::new(base);
    c.publish("market:quote:AAPL", serde_json::json!({"price": 187.5}))
        .await
        .unwrap();
    let v = c.peek("market:quote:AAPL").await.unwrap().unwrap();
    assert_eq!(v["price"], 187.5);
    // Unknown topic → None.
    let nope = c.peek("unknown:topic").await.unwrap();
    assert!(nope.is_none());
}
