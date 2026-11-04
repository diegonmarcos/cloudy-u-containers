use fin_api::{build_router, AppState};
use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .init();

    let state = AppState::try_new()?;
    // FinTerm (#1351): restore the last-good answers (FINTERM_DB, when set), then run every declared fetch job on its schedule
    fin_api::finterm::scheduler::start(state.clone()).await;
    let app = build_router(state);

    let port: u16 = std::env::var("FIN_API_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);
    // Defensive default: 127.0.0.1 (loopback). NEVER 0.0.0.0 — a misconfigured
    // deploy must not silently expose the service on every interface.
    // compose.nix passes FIN_API_HOST = WG IP from cloud-data.
    let host: IpAddr = std::env::var("FIN_API_HOST")
        .ok()
        .and_then(|s| IpAddr::from_str(s.trim()).ok())
        .unwrap_or_else(|| IpAddr::from([127, 0, 0, 1]));
    let addr: SocketAddr = SocketAddr::new(host, port);
    tracing::info!(%addr, "fin-api listening");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
