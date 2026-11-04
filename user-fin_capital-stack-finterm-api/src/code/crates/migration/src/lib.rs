//! Migrate upstream FinceptTerminal SQLite state into the Rust schema.
//!
//! The upstream app (C++ Qt) stores user state in `main.db` alongside 18
//! numbered migrations. We re-key the user-facing tables (watchlists,
//! portfolios, key-value settings) into the Rust schema. Analytics + cache
//! tables are not migrated — they rehydrate from connectors on first run.
//!
//! Phase 10a covers: schema bootstrap + watchlists + portfolios + settings.
//! Phase 10b will add saved screener presets, saved node-graphs, and
//! per-profile theme choice.

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::str::FromStr;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("source schema version {found} is not supported (expected ≥ {min})")]
    UnsupportedVersion { found: i64, min: i64 },
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Minimum upstream schema version we know how to migrate from.
pub const MIN_SOURCE_VERSION: i64 = 10;

/// Open a SQLite DB read-write (created if missing).
pub async fn open_pool(path: &str) -> Result<SqlitePool> {
    let opts = SqliteConnectOptions::from_str(&format!("sqlite://{path}"))?
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(opts)
        .await?;
    Ok(pool)
}

/// Create the minimal Rust-side tables used by the migration. Idempotent.
pub async fn ensure_rust_schema(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS watchlist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            symbol TEXT NOT NULL,
            UNIQUE(name, symbol)
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS portfolio_holding (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account TEXT NOT NULL,
            symbol TEXT NOT NULL,
            quantity REAL NOT NULL,
            avg_price REAL NOT NULL
        )",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE TABLE IF NOT EXISTS setting (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Check the upstream `schema_migrations` version. Returns the numeric
/// version if present; `None` if the table doesn't exist (treated as a
/// very old DB and rejected).
pub async fn upstream_version(src: &SqlitePool) -> Result<Option<i64>> {
    let row = sqlx::query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )
    .fetch_optional(src)
    .await?;
    if row.is_none() {
        return Ok(None);
    }
    let v: Option<(i64,)> = sqlx::query_as("SELECT MAX(version) FROM schema_migrations")
        .fetch_optional(src)
        .await?;
    Ok(v.and_then(|(n,)| if n > 0 { Some(n) } else { None }))
}

/// Seed the upstream DB with the schema we'll migrate from. Used by tests
/// and by tooling that fabricates a golden-file DB.
pub async fn seed_upstream_schema(src: &SqlitePool) -> Result<()> {
    sqlx::query("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)")
        .execute(src)
        .await?;
    sqlx::query(
        "CREATE TABLE watchlists (
            id INTEGER PRIMARY KEY,
            list_name TEXT NOT NULL,
            ticker TEXT NOT NULL
        )",
    )
    .execute(src)
    .await?;
    sqlx::query(
        "CREATE TABLE portfolios (
            id INTEGER PRIMARY KEY,
            account_name TEXT NOT NULL,
            ticker TEXT NOT NULL,
            qty REAL NOT NULL,
            avg_price REAL NOT NULL
        )",
    )
    .execute(src)
    .await?;
    sqlx::query(
        "CREATE TABLE kv_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
    )
    .execute(src)
    .await?;
    sqlx::query("INSERT INTO schema_migrations VALUES (?)")
        .bind(MIN_SOURCE_VERSION)
        .execute(src)
        .await?;
    Ok(())
}

/// Migrate user state from `src` (upstream C++ schema) to `dst` (Rust schema).
/// Returns a summary of counts copied.
pub async fn migrate(src: &SqlitePool, dst: &SqlitePool) -> Result<MigrationReport> {
    let version = upstream_version(src).await?;
    let v = version.ok_or(Error::UnsupportedVersion {
        found: 0,
        min: MIN_SOURCE_VERSION,
    })?;
    if v < MIN_SOURCE_VERSION {
        return Err(Error::UnsupportedVersion {
            found: v,
            min: MIN_SOURCE_VERSION,
        });
    }

    ensure_rust_schema(dst).await?;

    let mut report = MigrationReport {
        source_version: v,
        watchlists: 0,
        portfolio_holdings: 0,
        settings: 0,
    };

    // Watchlists
    let rows = sqlx::query("SELECT list_name, ticker FROM watchlists")
        .fetch_all(src)
        .await?;
    for r in rows {
        let name: String = r.try_get("list_name")?;
        let ticker: String = r.try_get("ticker")?;
        sqlx::query("INSERT OR IGNORE INTO watchlist (name, symbol) VALUES (?, ?)")
            .bind(&name)
            .bind(&ticker)
            .execute(dst)
            .await?;
        report.watchlists += 1;
    }

    // Portfolios
    let rows = sqlx::query("SELECT account_name, ticker, qty, avg_price FROM portfolios")
        .fetch_all(src)
        .await?;
    for r in rows {
        let account: String = r.try_get("account_name")?;
        let symbol: String = r.try_get("ticker")?;
        let qty: f64 = r.try_get("qty")?;
        let price: f64 = r.try_get("avg_price")?;
        sqlx::query(
            "INSERT INTO portfolio_holding (account, symbol, quantity, avg_price) VALUES (?, ?, ?, ?)",
        )
        .bind(&account)
        .bind(&symbol)
        .bind(qty)
        .bind(price)
        .execute(dst)
        .await?;
        report.portfolio_holdings += 1;
    }

    // Settings
    let rows = sqlx::query("SELECT key, value FROM kv_settings")
        .fetch_all(src)
        .await?;
    for r in rows {
        let key: String = r.try_get("key")?;
        let value: String = r.try_get("value")?;
        sqlx::query("INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)")
            .bind(&key)
            .bind(&value)
            .execute(dst)
            .await?;
        report.settings += 1;
    }

    Ok(report)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MigrationReport {
    pub source_version: i64,
    pub watchlists: u64,
    pub portfolio_holdings: u64,
    pub settings: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn mem_pool() -> SqlitePool {
        open_pool(":memory:").await.unwrap()
    }

    async fn seed_fixture(pool: &SqlitePool) {
        seed_upstream_schema(pool).await.unwrap();
        sqlx::query("INSERT INTO watchlists (list_name, ticker) VALUES (?, ?)")
            .bind("US Tech")
            .bind("AAPL")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO watchlists (list_name, ticker) VALUES (?, ?)")
            .bind("US Tech")
            .bind("TSLA")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO portfolios (account_name, ticker, qty, avg_price) VALUES (?, ?, ?, ?)",
        )
        .bind("main")
        .bind("AAPL")
        .bind(10.0_f64)
        .bind(150.0_f64)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO kv_settings (key, value) VALUES (?, ?)")
            .bind("theme")
            .bind("dark")
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn migration_copies_user_state() {
        let src = mem_pool().await;
        let dst = mem_pool().await;
        seed_fixture(&src).await;

        let report = migrate(&src, &dst).await.unwrap();
        assert_eq!(report.source_version, MIN_SOURCE_VERSION);
        assert_eq!(report.watchlists, 2);
        assert_eq!(report.portfolio_holdings, 1);
        assert_eq!(report.settings, 1);

        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM watchlist")
            .fetch_one(&dst)
            .await
            .unwrap();
        assert_eq!(count.0, 2);
        let theme: (String,) = sqlx::query_as("SELECT value FROM setting WHERE key='theme'")
            .fetch_one(&dst)
            .await
            .unwrap();
        assert_eq!(theme.0, "dark");
    }

    #[tokio::test]
    async fn missing_schema_table_rejects() {
        let src = mem_pool().await;
        let dst = mem_pool().await;
        let err = migrate(&src, &dst).await.unwrap_err();
        assert!(matches!(err, Error::UnsupportedVersion { .. }));
    }

    #[tokio::test]
    async fn stale_schema_version_rejects() {
        let src = mem_pool().await;
        let dst = mem_pool().await;
        // Seed at version 5 — below MIN_SOURCE_VERSION.
        sqlx::query("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY)")
            .execute(&src)
            .await
            .unwrap();
        sqlx::query("INSERT INTO schema_migrations VALUES (5)")
            .execute(&src)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE watchlists (id INTEGER, list_name TEXT, ticker TEXT)")
            .execute(&src)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE portfolios (id INTEGER, account_name TEXT, ticker TEXT, qty REAL, avg_price REAL)")
            .execute(&src).await.unwrap();
        sqlx::query("CREATE TABLE kv_settings (key TEXT, value TEXT)")
            .execute(&src)
            .await
            .unwrap();
        let err = migrate(&src, &dst).await.unwrap_err();
        assert!(matches!(err, Error::UnsupportedVersion { .. }));
    }

    #[tokio::test]
    async fn migration_is_idempotent() {
        let src = mem_pool().await;
        let dst = mem_pool().await;
        seed_fixture(&src).await;
        migrate(&src, &dst).await.unwrap();
        // Run it again — watchlist table has UNIQUE(name,symbol) so INSERT OR IGNORE keeps it at 2.
        migrate(&src, &dst).await.unwrap();
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM watchlist")
            .fetch_one(&dst)
            .await
            .unwrap();
        assert_eq!(count.0, 2);
    }
}
