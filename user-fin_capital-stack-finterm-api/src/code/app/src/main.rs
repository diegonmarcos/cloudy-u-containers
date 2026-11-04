use anyhow::Result;
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    info!(
        version = env!("CARGO_PKG_VERSION"),
        "Fincept Terminal (Rust) — Phase 0 scaffold"
    );
    info!("core result check: {:?}", fincept_core::ok_unit());
    Ok(())
}
