use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use fincept_datahub::value;
use serde::Serialize;

use crate::state::AppState;

#[derive(Serialize)]
pub struct TopicStatsDto {
    pub topic: String,
    pub subscriber_count: usize,
    pub total_publishes: u64,
    pub in_flight: bool,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/topics", get(list))
        .route("/api/v1/topics/{topic}/publish", post(publish))
        .route("/api/v1/topics/{topic}/peek", get(peek))
}

async fn list(State(s): State<AppState>) -> Json<Vec<TopicStatsDto>> {
    Json(
        s.hub
            .stats()
            .into_iter()
            .map(|t| TopicStatsDto {
                topic: t.topic,
                subscriber_count: t.subscriber_count,
                total_publishes: t.total_publishes,
                in_flight: t.in_flight,
            })
            .collect(),
    )
}

async fn publish(
    State(s): State<AppState>,
    Path(topic): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> StatusCode {
    s.hub.publish(&topic, value(body));
    StatusCode::NO_CONTENT
}

async fn peek(
    State(s): State<AppState>,
    Path(topic): Path<String>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    match s.hub.peek(&topic) {
        Some(v) => Ok(Json((*v).clone())),
        None => Err(StatusCode::NOT_FOUND),
    }
}
