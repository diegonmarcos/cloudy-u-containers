use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use fincept_mcp::ToolSpec;

use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/mcp/tools", get(list))
        .route("/api/v1/mcp/tools/{name}/call", post(call))
}

async fn list(State(s): State<AppState>) -> Json<Vec<ToolSpec>> {
    Json(s.mcp.list())
}

async fn call(
    State(s): State<AppState>,
    Path(name): Path<String>,
    Json(args): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    match s.mcp.call(&name, args).await {
        Ok(v) => Ok(Json(v)),
        Err(fincept_mcp::Error::NotFound(_)) => {
            Err((StatusCode::NOT_FOUND, format!("tool '{name}' not found")))
        }
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }
}
