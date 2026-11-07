//! JMAP-native email sorter for Stalwart — dynamic filter views.
//!
//! Routing is owned by the native Sieve (`_shared/lib/derive-mail-rules.ts::toSieve`):
//! each inbound email lands in INBOX (read) plus exactly one numeric `1*`-`9*`
//! category folder as an UNREAD copy. This sorter does NOT route and does not
//! set `$seen`.
//!
//! Instead it maintains the dynamic cross-cutting filter folders
//! `A*`/`B*`/`C*`/`D*` (size / time / read-state / attachment) over the emails
//! living in the numeric folders, using JMAP multi-mailbox membership: the
//! existing message is added to the filter mailbox — no copies, no keyword
//! changes. Each poll re-evaluates and both adds AND removes membership so the
//! time and read-state windows stay current.

mod filters;
mod inbox_guard;
mod jmap;
mod mailboxes;
mod routing;
mod rules;

use anyhow::{bail, Result};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rules::Rules;

/// Seconds since the Unix epoch.
pub fn now_epoch() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn env_or<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// True if this error is a transport failure worth reconnecting over, rather
/// than a per-poll logic error. Mirrors the Python's `except URLError: break`.
fn is_transport_error(err: &anyhow::Error) -> bool {
    err.chain().any(|c| {
        c.downcast_ref::<reqwest::Error>()
            .is_some_and(|e| e.is_connect() || e.is_timeout() || e.is_request())
    })
}


/// Name of the sentinel mailbox the SuperApp creates to ask for an immediate
/// re-apply. A mailbox, not a keyword or an HTTP endpoint, because JMAP
/// mailboxes are just tags: creating one needs no new service, no new port and
/// no secret in the APK, and the sorter is already authenticated to see it.
const REAPPLY_SENTINEL: &str = ".reapply";

/// Poll in short ticks so a tap does not wait out the full interval. Each tick
/// is one cheap `Mailbox/get`; the expensive pass still runs at most once per
/// POLL_INTERVAL, or immediately when the sentinel shows up.
const TICK: Duration = Duration::from_secs(10);

/// True if the sentinel exists. Consumes it, so one tap means one pass and a
/// failed pass does not loop forever on a sentinel nobody cleared.
fn take_reapply_request(client: &jmap::Client) -> Result<bool> {
    let Some(mb) = client
        .mailbox_get()?
        .into_iter()
        .find(|m| m.name == REAPPLY_SENTINEL)
    else {
        return Ok(false);
    };
    // Destroy without touching mail: the sentinel never holds any.
    client.mailbox_set(None, None, Some(vec![mb.id]), false)?;
    tracing::info!("re-apply requested via {REAPPLY_SENTINEL} — running now");
    Ok(true)
}

fn one_poll(client: &jmap::Client, rules: &Rules) -> Result<()> {
    // One-time in-place renames first (old -> new name), so a renamed folder
    // keeps its emails instead of being recreated empty and the old one reaped
    // by cleanup_stale. Idempotent.
    apply_renames_step(client, rules)?;
    let (name_to_id, mailboxes) = mailboxes::ensure_mailboxes(client, rules)?;
    // Inbox invariant (see inbox_guard.rs): arm the Email/set guard, then
    // heal any message that lost Inbox BEFORE views/routing evaluate it.
    if let Some(id) = mailboxes::find_inbox_id(&mailboxes) {
        client.set_inbox_id(id);
    }
    inbox_guard::maintain_inbox_invariant(client, &mailboxes)?;
    // Run every poll — cleanup is idempotent (no stale -> no-op) and
    // self-healing. This used to be gated on `first_run`, so a single bad
    // first poll left orphans until the container restarted.
    mailboxes::cleanup_stale(client, rules, &name_to_id, &mailboxes)?;
    // Routing is owned by the Sieve. The sorter only maintains the dynamic
    // A*/B*/C*/D* filter views over the emails in the numeric folders
    // (membership add/remove; no $seen/$Sorted, no copies).
    filters::maintain_filters(client, rules, &name_to_id, &mailboxes)?;
    // Routing is owned by the Sieve at DELIVERY, but sieve never revisits a
    // message. Re-applying the same rules here is what makes a rule fix reach
    // mail that already arrived -- see routing.rs.
    routing::maintain_routing(client, rules, &name_to_id, &mailboxes)?;
    Ok(())
}

fn apply_renames_step(client: &jmap::Client, rules: &Rules) -> Result<()> {
    let mailboxes = client.mailbox_get()?;
    mailboxes::apply_renames(client, rules, &mailboxes)
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .init();

    let rules_path = std::env::var("RULES_PATH").unwrap_or_else(|_| "/data/mail-rules.json".into());

    // `--check` validates the rules file and exits. Lets the generated
    // mail-rules.json be verified without a running server (CI, or
    // `docker exec stalwart-sorter jmap-sorter --check` on the box).
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--check") {
        let path = args.iter().find(|a| !a.starts_with("--")).cloned().unwrap_or(rules_path);
        let rules = Rules::load(&path)?;
        println!(
            "{path}: OK — {} routing folders, {} section headers, {} filter views",
            rules.folders.len(),
            rules.folders_ui.len() + rules.filters.section_headers.len(),
            rules.filters.views.len(),
        );
        return Ok(());
    }

    let jmap_url = std::env::var("JMAP_URL").unwrap_or_else(|_| "https://localhost:2443".into());
    let poll_interval = Duration::from_secs(env_or("POLL_INTERVAL", 30u64));
    let startup_delay = Duration::from_secs(env_or("STARTUP_DELAY", 20u64));

    // Load and validate BEFORE the startup delay: a malformed rules file is a
    // permanent error, and failing in 20ms instead of 20s makes the crash loop
    // visible to `docker ps` immediately instead of looking like a slow boot.
    let rules = Rules::load(&rules_path)?;
    let user = rules.account.clone();

    let password = std::env::var("ME_PASSWORD")
        .ok()
        .filter(|p| !p.is_empty())
        .or_else(|| std::env::var("ADMIN_PASSWORD").ok().filter(|p| !p.is_empty()));
    let Some(password) = password else {
        bail!("No password set (ME_PASSWORD or ADMIN_PASSWORD), exiting");
    };

    tracing::info!(
        "Starting JMAP sorter — delay {}s, poll every {}s, {} filter views",
        startup_delay.as_secs(),
        poll_interval.as_secs(),
        rules.filters.views.len()
    );
    std::thread::sleep(startup_delay);

    let mut client = jmap::Client::new(&jmap_url, &user, &password)?;
    let mut reconnect_delay = Duration::from_secs(5);

    loop {
        match client.discover() {
            Ok(_) => {
                tracing::info!("Connected to {jmap_url} as {user}");
                reconnect_delay = Duration::from_secs(5);
            }
            Err(e) => {
                tracing::error!("Connection failed: {e:#} (retry in {}s)", reconnect_delay.as_secs());
                std::thread::sleep(reconnect_delay);
                reconnect_delay = (reconnect_delay * 2).min(Duration::from_secs(120));
                continue;
            }
        }

        loop {
            if let Err(e) = one_poll(&client, &rules) {
                if is_transport_error(&e) {
                    tracing::warn!("Connection lost: {e:#}, reconnecting...");
                    break;
                }
                tracing::error!("Sort error: {e:#}");
            }

            // Sleep in ticks so the sentinel is noticed in ~10s rather than up
            // to POLL_INTERVAL. A tick is one Mailbox/get against a handful of
            // mailboxes -- nothing next to the full pass, which is what let the
            // interval go to 300s in the first place.
            let mut slept = Duration::ZERO;
            while slept < poll_interval {
                std::thread::sleep(TICK);
                slept += TICK;
                match take_reapply_request(&client) {
                    Ok(true) => break,
                    Ok(false) => {}
                    Err(e) if is_transport_error(&e) => break,
                    Err(e) => tracing::warn!("sentinel check failed: {e:#}"),
                }
            }
        }
    }
}
