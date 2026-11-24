//! maddy-sorter — the Rust equivalent of Stalwart's jmap-sorter, but for
//! Maddy's IMAP/SQLite backend.
//!
//! Runs `apply-rules` on a fixed interval for the container's lifetime,
//! started by init.sh alongside `maddy run`. Replaces both the external
//! Dagu DAG that used to ssh in every 2 minutes (see this repo's git log
//! for the incident that caused: a hung ssh call let two apply-rules
//! processes run at once and livelock SQLite) AND the bash
//! `cmd_apply_rules` in mail-sieve-subset-post-hoc.sh, which is now dead
//! code kept only for reference during the transition (derive-mail-rules.ts
//! target: remove once this has soaked).
//!
//! Every message the config's `filters.views` (axis="sender") predicates
//! describe stays fully data-driven from /data/mail-rules.json — nothing
//! about WHICH domain routes WHERE is hardcoded here, same as the
//! Stalwart crate. What IS hardcoded: JMAP/IMAP protocol literals
//! (`\Seen`) and this engine's own internal bookkeeping keyword
//! (`$distributed`) — neither is "rules data", both are implementation
//! detail, same category as Stalwart's hardcoded `$sorted`/`$seen`.

mod axes;
mod db;
mod deliver;
mod email;
mod jev;
mod rules;

use anyhow::Result;
use rules::{Rules, AXIS_AUTH, AXIS_SENDER};
use std::time::Duration;

fn env_or<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// IMAP's own special-use folders. Never reaped, never routed into —
/// mirrors SYSTEM_FOLDERS in the Stalwart crate's mailboxes.rs.
const SYSTEM_FOLDERS: &[&str] = &[
    "INBOX", "Sent", "Drafts", "Trash", "Junk", "Archive",
    "Sent Items", "Deleted Items", "Junk Mail", "Outbox", "Templates",
];

/// The complete set of folder names Maddy is supposed to have: INBOX and
/// the IMAP system folders, plus the F0 sender folders the rules declare.
/// Everything else is a leftover to be reaped (after rehoming — see
/// [`db::cleanup_stale_mailboxes`]).
///
/// Deliberately NOT including the numeric `1*`-`9*` folders: those are the
/// Stalwart/JMAP side's project-scoped scheme. Maddy is INBOX + senders.
fn valid_folder_names(rules: &Rules) -> std::collections::HashSet<String> {
    let mut valid: std::collections::HashSet<String> =
        SYSTEM_FOLDERS.iter().map(|s| s.to_string()).collect();
    valid.extend(rules.rules.iter().map(|r| r.folder.clone()));
    valid.insert(rules.routing_default.clone());
    valid
}

fn one_run(db_path: &str, rules_path: &str, rules: &Rules) -> Result<()> {
    let mut conn = db::open(db_path)?;
    let user_id = db::find_user_id(&conn, &rules.account)?;
    let inbox_id = db::find_mailbox_id(&conn, user_id, "INBOX")?
        .ok_or_else(|| anyhow::anyhow!("INBOX not found for {}", rules.account))?;

    // Reap folders the rules no longer declare, rehoming their mail into
    // INBOX first. Idempotent: once the fleet is clean this is a single
    // cheap SELECT per poll that finds nothing.
    let (dropped, rehomed) = db::cleanup_stale_mailboxes(
        &mut conn,
        user_id,
        inbox_id,
        &valid_folder_names(rules),
    )?;
    if dropped > 0 {
        tracing::info!("cleanup: dropped {dropped} stale folder(s), rehomed {rehomed} message(s) to INBOX");
    }

    let fallback_id = db::find_mailbox_id(&conn, user_id, &rules.routing_default)?;
    settle_jev_outcomes(db_path, rules, &conn, inbox_id, user_id);

    // Ruleset-change detection: if the SENDER rules changed since the last run, re-open ($distributed
    // cleared) any INBOX message whose only existing category copy is in the fallback folder, so the next
    // scan re-evaluates it against the new rules instead of leaving it permanently fallback-filed under a
    // stale decision.
    //
    // The hash covers the sender rules only (see [`db::sender_ruleset_hash`]): the G0 _ AUTH axis is
    // independent, and editing it must never clear `$distributed` on live mail. A build that introduces
    // this state file finds no previous value and re-opens nothing.
    let state_path = db::state_file_path(db_path);
    let sender_state_path = db::sender_state_file_path(db_path);
    let new_hash = db::ruleset_hash(rules_path)?;
    let new_sender_hash = db::sender_ruleset_hash(rules_path)?;
    let old_sender_hash = db::read_state_hash(&sender_state_path);
    if let (Some(old), Some(fb_id)) = (old_sender_hash, fallback_id) {
        if old != new_sender_hash {
            let ids = db::fallback_only_distributed_ids(&conn, inbox_id, fb_id)?;
            if !ids.is_empty() {
                tracing::info!("sender ruleset changed — re-opening {} fallback-only message(s)", ids.len());
                db::clear_distributed(&conn, inbox_id, &ids)?;
            }
        }
    }

    let candidates = db::undistributed_inbox_rows(&conn, inbox_id)?;
    if candidates.is_empty() {
        db::resync_msgs_count(&conn, user_id)?;
        db::write_state_hash(&state_path, new_hash)?;
        db::write_state_hash(&sender_state_path, new_sender_hash)?;
        auth_backfill(db_path, rules_path, rules, &mut conn, inbox_id, user_id)?;
        return Ok(());
    }
    tracing::info!("{} undistributed INBOX message(s)", candidates.len());

    // #882 S1: Jev may refile FALLBACK rows of the sender axis (no opinion = the rules' folder, unchanged)
    let advisor = jev::Sidecar::from_env();
    let jev_cands = jev::candidates(rules);
    let jev_cap: usize = env_or("JEV_SORTER_MAX", 20usize);
    let mut jev_asked = 0usize;
    let mut jev_pending: Vec<jev::Pending> = Vec::new();

    let mut plans = Vec::new();
    let mut all_ids = Vec::with_capacity(candidates.len());
    for (msg_id, cached_header) in &candidates {
        all_ids.push(*msg_id);
        let email = match db::parse_email(cached_header) {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!("msgId {msg_id}: cachedHeader unparseable, filing to fallback only: {e:#}");
                continue;
            }
        };
        // One copy per declared axis: the sender folder (routing default as fallback) and, where the
        // rules declare it, the G0 _ AUTH folder. Sender copies start unread (the working set); auth copies are
        // a classification of mail that is already in INBOX, so they keep the original's state (read) instead of
        // inflating every unread count with a second copy of everything.
        for axis in axes::declared_axes(rules) {
            if let Some(folder) = axes::folder_for(rules, &email, axis) {
                let mut target = folder.to_string();
                if axis == AXIS_SENDER {
                    let (t, call) = jev::refine(
                        rules,
                        &email,
                        folder,
                        advisor.as_ref().map(|a| a as &dyn jev::Advisor),
                        &jev_cands,
                        &mut jev_asked,
                        jev_cap,
                    );
                    if let Some(call) = call {
                        jev_pending.push(jev::Pending { call, src_msg_id: *msg_id, at: db::now_secs() });
                    }
                    target = t;
                }
                plans.push(db::Plan {
                    target_folder: target,
                    src_msg_id: *msg_id,
                    keep_seen: axis == AXIS_AUTH,
                });
            }
        }
    }

    db::backup_if_due(db_path, backup_min_interval())?;
    let (copied, skipped) = db::apply_plan(&mut conn, inbox_id, user_id, &plans, &all_ids)?;
    tracing::info!("copied={copied} skipped={skipped} of {} planned", plans.len());
    if !jev_pending.is_empty() {
        let path = jev::pending_path(db_path);
        let mut all = jev::load_pending(&path);
        all.extend(jev_pending);
        jev::save_pending(&path, &all);
    }

    db::resync_msgs_count(&conn, user_id)?;
    db::write_state_hash(&state_path, new_hash)?;
    db::write_state_hash(&sender_state_path, new_sender_hash)?;
    auth_backfill(db_path, rules_path, rules, &mut conn, inbox_id, user_id)?;
    Ok(())
}

/// #882: post the outcome of Jev decisions old enough to have been acted on: the one declared sender folder
/// that now holds the message (where the user left or moved it). Entries with nothing to learn are dropped
/// after JEV_OUTCOME_MAX_DAYS. Best effort; never fails the run.
fn settle_jev_outcomes(db_path: &str, rules: &Rules, conn: &rusqlite::Connection, inbox_id: i64, user_id: i64) {
    let Some(sc) = jev::Sidecar::from_env() else { return };
    let path = jev::pending_path(db_path);
    let list = jev::load_pending(&path);
    if list.is_empty() {
        return;
    }
    let after: u64 = env_or("JEV_OUTCOME_AFTER_S", 3 * 86400u64);
    let give_up: u64 = env_or("JEV_OUTCOME_MAX_DAYS", 30u64) * 86400;
    let cands = jev::candidates(rules);
    let now = db::now_secs();
    let mut keep = Vec::new();
    for p in list {
        let age = now.saturating_sub(p.at);
        if age < after {
            keep.push(p);
            continue;
        }
        let holding = db::folders_holding_copy(conn, inbox_id, user_id, p.src_msg_id).unwrap_or_default();
        match jev::observed_label(&holding, &cands) {
            Some(label) => jev::send_outcome(&sc.base, &p.call, &label, sc.timeout),
            None if age < give_up => keep.push(p),
            None => {}
        }
    }
    jev::save_pending(&path, &keep);
}

/// Minimum age of the newest imapsql.db backup before another one is taken (`BACKUP_MIN_INTERVAL`, seconds;
/// default 6 h). See [`db::backup_if_due`] for the incident behind it.
fn backup_min_interval() -> Duration {
    Duration::from_secs(env_or("BACKUP_MIN_INTERVAL", 6 * 3600u64))
}

static DRY_RUN_LOGGED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// What the auth backfill does, from `AUTH_BACKFILL`: `off` nothing; `dry` reads the whole
/// INBOX and LOGS how many messages each auth class would receive, writing nothing; `apply` (the DEFAULT since the dry run read 17 Ga / 14 Gb / 13491 Gc = the 13522 INBOX messages) COPIES them.
/// Copy only, always: no INBOX original, flag or existing folder is touched.
fn auth_backfill_mode() -> String {
    std::env::var("AUTH_BACKFILL").unwrap_or_else(|_| "apply".into())
}

/// Give the mail that was already in INBOX before the G0 _ AUTH axis existed its auth-folder copy.
///
/// `$distributed` mail is never re-scanned by the ordinary pass, so the backlog would otherwise never be
/// classified. This walks the INBOX in bounded pages, plans the auth folder of each message, and (in `apply`
/// mode) copies them with `keep_seen` so a backlog does not arrive as unread. Idempotent: the per-body
/// duplicate check skips what a folder already holds, and a completed backfill is remembered by the hash of
/// the auth rules, so it re-runs only when those rules change.
fn auth_backfill(
    db_path: &str,
    rules_path: &str,
    rules: &Rules,
    conn: &mut rusqlite::Connection,
    inbox_id: i64,
    user_id: i64,
) -> Result<()> {
    if !axes::declared_axes(rules).contains(&AXIS_AUTH) {
        return Ok(());
    }
    let mode = auth_backfill_mode();
    if mode == "off" {
        return Ok(());
    }
    let state = db::auth_backfill_state_path(db_path);
    let hash = db::auth_ruleset_hash(rules_path)?;
    if mode == "apply" && db::read_state_hash(&state) == Some(hash) {
        return Ok(());
    }

    // A dry run is logged once per process: it re-walks the whole INBOX, so it must not repeat every poll.
    if mode != "apply" && DRY_RUN_LOGGED.load(std::sync::atomic::Ordering::Relaxed) {
        return Ok(());
    }

    // 2026-11-18 oci-mail incident: the "done" hash above is written only after a fully successful pass, so
    // any error (a locked DB, a failed backup, an OOM kill mid-copy) made EVERY poll re-walk the whole INBOX,
    // back up the DB and re-run the copy. An attempt for these auth rules is now recorded BEFORE the walk,
    // and a failed or interrupted attempt is retried at most once per BACKUP_MIN_INTERVAL instead of every
    // poll. The retry itself stays (the copy is idempotent per body).
    let attempt = db::auth_backfill_attempt_path(db_path);
    if mode == "apply" {
        if let Some(age) = db::attempt_age(&attempt, hash) {
            if age < backup_min_interval() {
                return Ok(());
            }
            tracing::warn!("auth backfill — retrying an attempt from {}s ago that did not complete", age.as_secs());
        }
        db::write_state_hash(&attempt, hash)?;
    }

    const PAGE: i64 = 2000;
    let mut after = 0i64;
    let mut per_folder: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    let mut plans: Vec<db::Plan> = Vec::new();
    loop {
        let page = db::inbox_rows_page(conn, inbox_id, after, PAGE)?;
        if page.is_empty() {
            break;
        }
        for (msg_id, header) in &page {
            after = *msg_id;
            let Ok(email) = db::parse_email(header) else { continue };
            if let Some(folder) = axes::folder_for(rules, &email, AXIS_AUTH) {
                *per_folder.entry(folder.to_string()).or_default() += 1;
                plans.push(db::Plan { target_folder: folder.to_string(), src_msg_id: *msg_id, keep_seen: true });
            }
        }
    }
    let summary = per_folder.iter().map(|(f, n)| format!("{f}={n}")).collect::<Vec<_>>().join(" | ");
    if mode != "apply" {
        DRY_RUN_LOGGED.store(true, std::sync::atomic::Ordering::Relaxed);
        tracing::info!("auth backfill DRY RUN — would copy {} message(s): {summary}", plans.len());
        return Ok(());
    }
    tracing::info!("auth backfill — copying {} message(s): {summary}", plans.len());
    db::backup_if_due(db_path, backup_min_interval())?;
    // No originals are marked: this is a copy-only pass.
    let (copied, skipped) = db::apply_plan(conn, inbox_id, user_id, &plans, &[])?;
    tracing::info!("auth backfill — copied={copied} skipped={skipped}");
    // Done as soon as the copy committed: a failing count resync must not re-run the whole backfill.
    db::write_state_hash(&state, hash)?;
    db::resync_msgs_count(conn, user_id)?;
    Ok(())
}

fn main() {
    // `maddy-sorter deliver ACCOUNT SENDER RCPT [SUBJECT]` is the per-message imap_filter hook (no logging setup, no
    // SQLite): it must stay as cheap as the shell script it replaces.
    let argv: Vec<String> = std::env::args().collect();
    if argv.get(1).map(String::as_str) == Some("deliver") {
        std::process::exit(deliver::main(&argv[2..]));
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let rules_path = std::env::var("RULES_PATH").unwrap_or_else(|_| "/data/mail-rules.json".into());
    let db_path = std::env::var("IMAPSQL_DB").unwrap_or_else(|_| "/data/imapsql.db".into());
    let poll_interval = Duration::from_secs(env_or("POLL_INTERVAL", 120u64));
    let startup_delay = Duration::from_secs(env_or("STARTUP_DELAY", 30u64));

    // Load and validate BEFORE the startup delay: a malformed rules file
    // is a permanent error, and failing in milliseconds instead of after
    // a 30s sleep makes the crash loop visible to `docker ps` immediately.
    let rules = match Rules::load(&rules_path) {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("{e:#}");
            std::process::exit(1);
        }
    };

    tracing::info!(
        "maddy-sorter starting — delay {}s, poll every {}s, {} sender routes",
        startup_delay.as_secs(),
        poll_interval.as_secs(),
        rules.rules.len()
    );
    std::thread::sleep(startup_delay);

    loop {
        if let Err(e) = one_run(&db_path, &rules_path, &rules) {
            tracing::error!("run failed: {e:#}");
        }
        std::thread::sleep(poll_interval);
    }
}
