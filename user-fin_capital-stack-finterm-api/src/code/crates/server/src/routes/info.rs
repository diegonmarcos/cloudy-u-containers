use axum::{extract::State, routing::get, Json, Router};
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
pub struct Info {
    pub version: &'static str,
    pub personas: usize,
    pub mcp_tools: usize,
    pub hub_topics: usize,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/v1/info", get(info))
}

async fn info(State(s): State<AppState>) -> Json<Info> {
    Json(Info {
        version: s.version,
        personas: s.personas.len(),
        mcp_tools: s.mcp.list().len(),
        hub_topics: s.hub.stats().len(),
    })
}
