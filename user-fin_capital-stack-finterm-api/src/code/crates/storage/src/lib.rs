//! SQLite storage layer. Phase 1 lands a thin `CacheManager` equivalent plus
//! the migration runner. Full schema port (18 migrations from
//! `fincept-qt/src/storage/sqlite/migrations/`) lands across Phases 1–2 as
//! screens that need each table come online.

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::str::FromStr;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("migrate: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Open (create if missing) a SQLite database at the given path and return a
/// connection pool. Pass `:memory:` for ephemeral in-process.
pub async fn open(path: &str) -> Result<SqlitePool> {
    let opts = SqliteConnectOptions::from_str(&format!("sqlite://{path}"))?
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(8)
        .connect_with(opts)
        .await?;
    Ok(pool)
}

/// Bootstrap the cache table used by the hub for TTL-based persistence.
/// Matches the behaviour of the Qt `CacheManager` table schema.
pub async fn ensure_cache_table(pool: &SqlitePool) -> Result<()> {
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS cache (
            key TEXT PRIMARY KEY,
            value BLOB NOT NULL,
            category TEXT,
            expires_at INTEGER,
            created_at INTEGER NOT NULL
        )",
    )
    .execute(pool)
    .await?;
    sqlx::query("CREATE INDEX IF NOT EXISTS idx_cache_expires ON cache(expires_at)")
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn in_memory_db_opens() {
        let pool = open(":memory:").await.unwrap();
        ensure_cache_table(&pool).await.unwrap();
        let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM cache")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0, 0);
    }

    #[tokio::test]
    async fn cache_table_insert_and_select() {
        let pool = open(":memory:").await.unwrap();
        ensure_cache_table(&pool).await.unwrap();

        sqlx::query(
            "INSERT INTO cache (key, value, category, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind("market:quote:AAPL")
        .bind(b"{\"price\":100}".as_slice())
        .bind("market")
        .bind(1_700_000_000_i64)
        .bind(1_700_000_000_i64 - 30)
        .execute(&pool)
        .await
        .unwrap();

        let row: (String, Vec<u8>) = sqlx::query_as("SELECT key, value FROM cache")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.0, "market:quote:AAPL");
        assert_eq!(row.1, b"{\"price\":100}");
    }
}
