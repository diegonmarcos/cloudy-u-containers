//! fin-api — HTTP + WebSocket shell around the Fincept Terminal Rust port's backend.
//!
//! Exposes:
//!   GET  /health                          — liveness
//!   GET  /api/v1/info                     — build info + counts
//!   GET  /api/v1/personas                 — investor persona roster
//!   POST /api/v1/personas/:id/score       — score a stock with a persona
//!   GET  /api/v1/topics                   — DataHub TopicStats dump
//!   POST /api/v1/topics/:topic/publish    — admin publish (for testing)
//!   GET  /api/v1/topics/:topic/peek       — current cached value
//!   GET  /api/v1/mcp/tools                — default MCP tool registry
//!   GET  /api/v1/ws                       — WebSocket: subscribe + push
//!   GET  /v1/...                          — FinTerm normalised API (#1351): catalog, series, curves, quotes,
//!                                           fx, calendars, fundamentals (see finterm/routes.rs)
//!
//! Auth/TLS is the deployment's job (Caddy + Authelia in front).

pub mod finterm;
pub mod routes;
pub mod state;
pub mod ws;

use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;

pub use state::AppState;

/// Build the Axum `Router` wired to a supplied `AppState`. Exposed for
/// integration tests (spin up the same router the binary does).
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .merge(routes::health::router())
        .merge(routes::info::router())
        .merge(routes::personas::router())
        .merge(routes::topics::router())
        .merge(routes::mcp::router())
        .merge(ws::router())
        .merge(finterm::routes::router())
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .with_state(state)
}
