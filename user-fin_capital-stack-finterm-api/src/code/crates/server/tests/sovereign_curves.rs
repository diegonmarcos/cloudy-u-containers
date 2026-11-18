//! #1786 `/v1/rates/sovereign-curves` end to end, with no live network: the declared sources are pointed at a loopback server
//! that answers with the answers recorded under `tests/fixtures/sovereign/` (or fails on purpose), the real router in front.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::any;
use axum::Router;
use fin_api::finterm::sovereign::{Sovereign, DECL_JSON};
use fin_api::{build_router, AppState};
use serde_json::Value;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

const FIX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sovereign/");

type Hits = Arc<Mutex<HashMap<String, usize>>>;

/// The recorded-answer server: `/f/<fixture>` serves the file, `/fail/<x>` answers 500; every hit is counted.
async fn fixtures() -> (String, Hits) {
    let hits: Hits = Arc::default();
    let app = Router::new()
        .route(
            "/f/{name}",
            any(|State(h): State<Hits>, Path(name): Path<String>| async move {
                *h.lock().unwrap().entry(name.clone()).or_default() += 1;
                match std::fs::read(format!("{FIX}{name}")) {
                    Ok(b) => (StatusCode::OK, b).into_response(),
                    Err(_) => StatusCode::NOT_FOUND.into_response(),
                }
            }),
        )
        .route(
            "/fail/{name}",
            any(|State(h): State<Hits>, Path(name): Path<String>| async move {
                *h.lock().unwrap().entry(format!("fail:{name}")).or_default() += 1;
                StatusCode::INTERNAL_SERVER_ERROR
            }),
        )
        .with_state(hits.clone());
    let l = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    (format!("http://{addr}"), hits)
}

/// The shipped declaration with every source address replaced by `urls[cc][i]` (a fixture or a failure).
fn decl(base: &str, urls: &[(&str, &[&str])]) -> String {
    let mut d: Value = serde_json::from_str(DECL_JSON).unwrap();
    for (cc, list) in urls {
        let srcs = d["countries"][*cc].as_array_mut().unwrap();
        assert_eq!(srcs.len(), list.len(), "{cc}: one address per declared source");
        for (s, u) in srcs.iter_mut().zip(list.iter()) {
            s["url"] = Value::String(format!("{base}{u}"));
        }
    }
    d.to_string()
}

async fn api(decl: &str) -> String {
    let mut state = AppState::try_new().unwrap();
    Arc::get_mut(&mut state.finterm).unwrap().sovereign = Sovereign::from_json(decl).unwrap();
    let l = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await.unwrap();
    let addr = l.local_addr().unwrap();
    let app = build_router(state);
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    format!("http://{addr}")
}

#[tokio::test]
async fn gb_jp_cn_from_the_recorded_answers_cached_and_failing_soft() {
    let (fx, hits) = fixtures().await;
    let base = api(&decl(
        &fx,
        &[
            ("GB", &["/f/boe_latest_yield_curve_data.zip", "/f/boe_iadb_zc.csv"]),
            // the current-month file fails: the history file (here the same recorded shape) answers
            ("JP", &["/fail/jgbcme.csv", "/f/mof_jgbcme.csv"]),
            // ChinaBond's chart service and table both fail: CN is unavailable with the reasons, never made up
            ("CN", &["/fail/czbChartSearch", "/fail/moreInfo"]),
        ],
    ))
    .await;
    let url = format!("{base}/v1/rates/sovereign-curves?countries=GB,JP,CN,US,XX&tenors=2,5,10,30");
    let r = reqwest::get(&url).await.unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["cache-control"], "public, max-age=3600");
    assert!(r.headers().get("x-stale").is_none());
    let x_source = r.headers()["x-source"].to_str().unwrap().to_string();
    assert!(x_source.contains("boe_glc_nominal_spot") && x_source.contains("mof_jgb_all"), "{x_source}");
    let v: Value = r.json().await.unwrap();

    let gb = &v["curves"]["GB"];
    assert_eq!(gb["2"]["date"], "2026-11-06");
    assert_eq!(gb["2"]["source"], "boe_glc_nominal_spot");
    assert!((gb["10"]["value"].as_f64().unwrap() - 5.1419214894746883).abs() < 1e-12);
    assert!(gb["30"]["value"].is_f64());

    let jp = &v["curves"]["JP"];
    assert_eq!(jp["2"]["value"], 1.878);
    assert_eq!(jp["5"]["value"], 2.274);
    assert_eq!(jp["10"]["value"], 2.925);
    assert_eq!(jp["30"]["value"], 4.069);
    assert_eq!(jp["10"]["date"], "2026-11-17");
    assert_eq!(jp["10"]["source"], "mof_jgb_all");

    assert!(v["curves"].get("CN").is_none(), "no CN value without a source");
    let cn = v["unavailable"]["CN"].as_str().unwrap();
    assert!(cn.contains("chinabond_cgb: answered 500") && cn.contains("chinabond_cgb_table: answered 500"), "{cn}");
    assert!(v["unavailable"]["US"].as_str().unwrap().contains("/v1/curves/ust_par"));
    assert!(v["unavailable"]["XX"].as_str().unwrap().contains("no free sovereign curve source"));
    assert_eq!(v["as_of"], "2026-11-17");
    assert_eq!(v["meta"]["GB"]["stale"], false);

    // the second answer comes from the cache: no new fetch, and CN's failure waits retry_s before the next try
    let before = hits.lock().unwrap().clone();
    let v2: Value = reqwest::get(&url).await.unwrap().json().await.unwrap();
    assert_eq!(v2["curves"], v["curves"]);
    assert_eq!(*hits.lock().unwrap(), before, "served from the cache");
    assert_eq!(before.get("boe_latest_yield_curve_data.zip"), Some(&1));
    assert_eq!(before.get("boe_iadb_zc.csv"), None, "the fallback is not fetched when the primary answers");
}

#[tokio::test]
async fn cn_from_chinabond_and_a_missing_tenor_is_left_out() {
    let (fx, _) = fixtures().await;
    let base = api(&decl(
        &fx,
        &[
            // the GLC archive fails: the IADB zero-coupon fallback has no 2y or 30y, so those are left out and named
            ("GB", &["/fail/glc.zip", "/f/boe_iadb_zc.csv"]),
            ("JP", &["/f/mof_jgbcme.csv", "/fail/all.csv"]),
            ("CN", &["/f/chinabond_chart.json", "/f/chinabond_moreinfo.html"]),
        ],
    ))
    .await;
    let v: Value = reqwest::get(format!("{base}/v1/rates/sovereign-curves")).await.unwrap().json().await.unwrap();
    assert_eq!(v["tenors"], serde_json::json!(["2", "5", "10", "30"]), "the declared defaults");
    let cn = &v["curves"]["CN"];
    assert_eq!(cn["2"]["value"], 1.2301);
    assert_eq!(cn["10"]["value"], 1.5892);
    assert_eq!(cn["10"]["date"], "2026-11-18");
    assert_eq!(cn["10"]["source"], "chinabond_cgb");
    let gb = &v["curves"]["GB"];
    assert!(gb.get("2").is_none() && gb.get("30").is_none());
    assert_eq!(gb["10"]["value"], 5.3337);
    assert_eq!(gb["10"]["source"], "boe_iadb_nominal_zc");
    assert_eq!(v["meta"]["GB"]["missing_tenors"], serde_json::json!(["2", "30"]));
    assert_eq!(v["curves"]["JP"]["10"]["source"], "mof_jgb");
    assert_eq!(v["as_of"], "2026-11-18");
}

#[tokio::test]
async fn everything_down_is_a_503_in_the_api_error_shape_and_bad_tenors_a_400() {
    let (fx, hits) = fixtures().await;
    let base = api(&decl(&fx, &[("GB", &["/fail/a", "/fail/b"]), ("JP", &["/fail/c", "/fail/d"]), ("CN", &["/fail/e", "/fail/f"])])).await;
    let r = reqwest::get(format!("{base}/v1/rates/sovereign-curves?countries=GB,JP,CN")).await.unwrap();
    assert_eq!(r.status(), 503);
    let v: Value = r.json().await.unwrap();
    assert!(v["error"].as_str().unwrap().starts_with("no answer yet"));
    assert_eq!(v["source"], "finterm");
    assert_eq!(v["unavailable"].as_object().unwrap().len(), 3);
    let n = hits.lock().unwrap().values().sum::<usize>();
    assert_eq!(n, 6, "each source tried once");
    let r = reqwest::get(format!("{base}/v1/rates/sovereign-curves?tenors=2,ten")).await.unwrap();
    assert_eq!(r.status(), 400);
    let v: Value = r.json().await.unwrap();
    assert!(v["error"].as_str().unwrap().contains("ten"));
}
