use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use fincept_agents_investors::{recommend, score, StockMetrics};
use serde::{Deserialize, Serialize};

use crate::state::AppState;

#[derive(Serialize)]
pub struct PersonaSummary {
    pub id: String,
    pub name: String,
    pub style: String,
}

#[derive(Deserialize)]
pub struct ScoreRequest {
    pub stock: StockMetrics,
}

#[derive(Serialize)]
pub struct ScoreResponse {
    pub persona: String,
    pub symbol: String,
    pub score: f64,
    pub recommendation: String,
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/personas", get(list))
        .route("/api/v1/personas/{id}/score", post(score_stock))
}

async fn list(State(s): State<AppState>) -> Json<Vec<PersonaSummary>> {
    let mut out: Vec<PersonaSummary> = s
        .personas
        .iter()
        .map(|(id, p)| PersonaSummary {
            id: id.clone(),
            name: p.name.clone(),
            style: p.style.clone(),
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Json(out)
}

async fn score_stock(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<ScoreRequest>,
) -> Result<Json<ScoreResponse>, (StatusCode, String)> {
    let persona = s
        .personas
        .get(&id)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("persona '{id}' not found")))?;
    let sc = score(persona, &req.stock);
    Ok(Json(ScoreResponse {
        persona: persona.name.clone(),
        symbol: req.stock.symbol,
        score: sc,
        recommendation: recommend(sc).to_string(),
    }))
}
