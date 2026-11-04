//! End-to-end HTTP smoke tests. Spin up the real router on a random port,
//! hit it with `reqwest`, assert shapes.

use fin_api::{build_router, AppState};
use std::net::SocketAddr;
use tokio::net::TcpListener;

async fn spawn_server() -> (String, tokio::task::JoinHandle<()>) {
    let state = AppState::try_new().expect("state init");
    let app = build_router(state);

    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}"), handle)
}

#[tokio::test]
async fn health_returns_ok() {
    let (base, _h) = spawn_server().await;
    let resp: serde_json::Value = reqwest::get(format!("{base}/health"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(resp["status"], "ok");
    assert!(resp["version"].is_string());
}

#[tokio::test]
async fn info_counts_resources() {
    let (base, _h) = spawn_server().await;
    let v: serde_json::Value = reqwest::get(format!("{base}/api/v1/info"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(v["personas"], 6);
    assert_eq!(v["mcp_tools"], 5);
}

#[tokio::test]
async fn personas_list_has_six() {
    let (base, _h) = spawn_server().await;
    let v: Vec<serde_json::Value> = reqwest::get(format!("{base}/api/v1/personas"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(v.len(), 6);
    let ids: Vec<&str> = v.iter().map(|p| p["id"].as_str().unwrap()).collect();
    for expected in ["buffett", "graham", "lynch", "munger", "klarman", "marks"] {
        assert!(ids.contains(&expected), "missing persona {expected}");
    }
}

#[tokio::test]
async fn score_endpoint_produces_recommendation() {
    let (base, _h) = spawn_server().await;
    let body = serde_json::json!({
        "stock": {
            "symbol": "AAPL",
            "pe_ratio": 12.0,
            "roe": 0.25,
            "debt_to_equity": 0.3,
            "fcf_yield": 0.08,
            "moat_score": 0.9
        }
    });
    let client = reqwest::Client::new();
    let resp: serde_json::Value = client
        .post(format!("{base}/api/v1/personas/buffett/score"))
        .json(&body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(resp["symbol"], "AAPL");
    assert_eq!(resp["persona"], "Buffett");
    assert!(resp["score"].as_f64().unwrap() > 70.0);
    assert!(matches!(
        resp["recommendation"].as_str().unwrap(),
        "strong_buy" | "buy"
    ));
}

#[tokio::test]
async fn topic_publish_and_peek_round_trip() {
    let (base, _h) = spawn_server().await;
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "price": 100.0 });
    client
        .post(format!("{base}/api/v1/topics/market:quote:AAPL/publish"))
        .json(&body)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();

    let v: serde_json::Value = client
        .get(format!("{base}/api/v1/topics/market:quote:AAPL/peek"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(v["price"], 100.0);
}

#[tokio::test]
async fn mcp_tools_lists_five_defaults() {
    let (base, _h) = spawn_server().await;
    let v: Vec<serde_json::Value> = reqwest::get(format!("{base}/api/v1/mcp/tools"))
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(v.len(), 5);
    let names: Vec<&str> = v.iter().map(|t| t["name"].as_str().unwrap()).collect();
    for n in [
        "market_data",
        "financial_news",
        "economics_data",
        "factor_backtest",
        "symbol_search",
    ] {
        assert!(names.contains(&n), "missing MCP tool {n}");
    }
}

#[tokio::test]
async fn unknown_persona_returns_404() {
    let (base, _h) = spawn_server().await;
    let body = serde_json::json!({
        "stock": {
            "symbol": "AAPL", "pe_ratio": 12.0, "roe": 0.25,
            "debt_to_equity": 0.3, "fcf_yield": 0.08, "moat_score": 0.9
        }
    });
    let resp = reqwest::Client::new()
        .post(format!("{base}/api/v1/personas/nobody/score"))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status().as_u16(), 404);
}

// #1351 FinTerm /v1: the catalog reports the generated declaration and every job, before any fetch ran.
#[tokio::test]
async fn finterm_catalog_lists_the_declared_jobs() {
    let (base, _h) = spawn_server().await;
    let v: serde_json::Value = reqwest::get(format!("{base}/v1/catalog")).await.unwrap().json().await.unwrap();
    assert_eq!(v["declaration_sha"].as_str().unwrap().len(), 64);
    let jobs = v["jobs"].as_array().unwrap();
    assert!(!jobs.is_empty());
    assert!(jobs.iter().all(|j| j["status"] == "pending"));
    assert!(jobs.iter().any(|j| j["serves"].as_array().unwrap().iter().any(|s| s == "/v1/calendar/economic")));
}

// The admin refresh is mesh only: a request that came through the edge (X-Forwarded-For) is refused.
#[tokio::test]
async fn finterm_admin_refresh_refuses_the_edge() {
    let (base, _h) = spawn_server().await;
    let r = reqwest::Client::new().post(format!("{base}/v1/admin/refresh/nope")).header("x-forwarded-for", "1.2.3.4").send().await.unwrap();
    assert_eq!(r.status().as_u16(), 403);
}
