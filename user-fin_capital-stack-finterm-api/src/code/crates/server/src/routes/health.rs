use axum::{routing::get, Json, Router};
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
pub struct Health {
    pub status: &'static str,
    pub version: &'static str,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/health", get(health))
}

async fn health(axum::extract::State(state): axum::extract::State<AppState>) -> Json<Health> {
    Json(Health {
        status: "ok",
        version: state.version,
    })
}
