//! `maddy-sorter integrity-check` — the read-only half of mail-sieve-subset-post-hoc.sh `integrity-check`, moved out of
//! the sqlite3 CLI + sort/comm/awk shell into the crate (#1883). Same report, same lines on stderr. It never writes:
//! the database is opened SQLITE_OPEN_READ_ONLY. (integrity-fix / dedupe / reseed-inbox-archive stay shell: they
//! mutate mail and move only after a shadow run on a database copy.)

use rusqlite::{Connection, OpenFlags};
use std::collections::BTreeSet;

fn log(msg: &str) {
    eprintln!("[post-hoc] {msg}");
}

fn count_where_body_key_in(conn: &Connection, keys: &BTreeSet<String>) -> anyhow::Result<i64> {
    // The shell counts msgs whose extBodyKey is IN the (distinct) orphan key set.
    let mut st = conn.prepare("SELECT COUNT(*) FROM msgs WHERE extBodyKey = ?1")?;
    let mut total = 0;
    for k in keys {
        total += st.query_row([k], |r| r.get::<_, i64>(0))?;
    }
    Ok(total)
}

fn run(db: &str, blob_dir: &str) -> anyhow::Result<()> {
    log("integrity-check: scanning DB rows ↔ blob files…");
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    conn.execute_batch("PRAGMA busy_timeout = 5000;")?;

    let total_msgs: i64 = conn.query_row("SELECT COUNT(*) FROM msgs", [], |r| r.get(0))?;
    let total_ext: i64 = conn.query_row("SELECT COUNT(*) FROM extKeys", [], |r| r.get(0))?;
    log(&format!("  msgs rows:                  {total_msgs}"));
    log(&format!("  extKeys rows:               {total_ext}"));

    let mut db_keys: BTreeSet<String> = BTreeSet::new();
    {
        let mut st = conn.prepare("SELECT id FROM extKeys")?;
        let rows = st.query_map([], |r| r.get::<_, String>(0))?;
        for k in rows {
            let k = k?;
            if !k.is_empty() {
                db_keys.insert(k);
            }
        }
    }
    let mut disk_keys: BTreeSet<String> = BTreeSet::new();
    if let Ok(rd) = std::fs::read_dir(blob_dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with('.') {
                disk_keys.insert(name);
            }
        }
    }
    log(&format!("  blob keys in DB (extKeys):  {}", db_keys.len()));
    log(&format!("  blob files on disk:         {}", disk_keys.len()));

    let orphan_keys: BTreeSet<String> = db_keys.difference(&disk_keys).cloned().collect();
    let dangling = disk_keys.difference(&db_keys).count();
    let orphan_msgs = if orphan_keys.is_empty() { 0 } else { count_where_body_key_in(&conn, &orphan_keys)? };
    log(&format!("  ORPHAN extKeys (no blob):   {}", orphan_keys.len()));
    log(&format!("  ORPHAN msgs (broken body):  {orphan_msgs}"));
    log(&format!("  DANGLING blobs (no DB ref): {dangling}"));

    let bad_refs: i64 = conn.query_row(
        "SELECT COUNT(*) FROM extKeys e WHERE e.refs != COALESCE((SELECT COUNT(*) FROM msgs WHERE extBodyKey = e.id), 0)",
        [],
        |r| r.get(0),
    )?;
    log(&format!("  extKeys with bad refs count:{bad_refs}"));
    Ok(())
}

/// Entry point; returns the process exit code.
pub fn main(_args: &[String]) -> i32 {
    let db = std::env::var("IMAPSQL_DB").unwrap_or_else(|_| "/data/imapsql.db".into());
    let blob_dir = std::env::var("BLOB_DIR").unwrap_or_else(|_| "/data/messages".into());
    if !std::path::Path::new(&db).is_file() {
        eprintln!("[post-hoc] ERROR: imapsql DB not found: {db}");
        return 1;
    }
    if !std::path::Path::new(&blob_dir).is_dir() {
        eprintln!("[post-hoc] ERROR: blob dir not found: {blob_dir}");
        return 1;
    }
    match run(&db, &blob_dir) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("[post-hoc] ERROR: {e:#}");
            1
        }
    }
}
