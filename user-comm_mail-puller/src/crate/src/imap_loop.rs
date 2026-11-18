//! Per-(source, mailbox) IMAP polling loop.
//!
//! Originally intended as IMAP IDLE for sub-second push. async-imap 0.9's IDLE
//! API consumes the Session into a Handle that isn't cleanly reclaimed for
//! subsequent commands, which is awkward for a long-running daemon. Polling is
//! boring but robust: every `poll_fallback_secs`, connect → SELECT → UID SEARCH
//! new → fetch → deliver → disconnect. Latency = cadence (default 300 s).
//! Cadence is tunable per-deploy via sources.json#defaults.poll_fallback_secs.

use anyhow::{anyhow, Context, Result};
use async_imap::{Authenticator, Client, Session};
use futures::StreamExt;
use std::{sync::Arc, time::Duration};
use tokio::net::TcpStream;
use tokio_rustls::{rustls::{ClientConfig, RootCertStore}, TlsConnector};
use tokio_util::compat::{Compat, TokioAsyncReadCompatExt};

use std::env;
use crate::{config::{AuthMethod, Config, Source}, deliver, oauth, state::State};

type ImapStream = Compat<tokio_rustls::client::TlsStream<TcpStream>>;

struct XOAuth2 {
    user: String,
    token: String,
}
impl Authenticator for &XOAuth2 {
    type Response = Vec<u8>;
    fn process(&mut self, _challenge: &[u8]) -> Self::Response {
        format!("user={}\x01auth=Bearer {}\x01\x01", self.user, self.token).into_bytes()
    }
}

fn tls_config() -> ClientConfig {
    let mut root = RootCertStore::empty();
    root.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    ClientConfig::builder()
        .with_root_certificates(root)
        .with_no_client_auth()
}

pub async fn run(src: &Source, mbox: &str, cfg: &Config, state: State) -> Result<()> {
    let interval = Duration::from_secs(cfg.defaults.poll_fallback_secs.max(10));
    tracing::info!(
        source   = %src.id,
        mailbox  = %mbox,
        host     = %src.imap_host,
        cadence  = ?interval,
        "poll loop starting"
    );

    // ponytail: idle cycles were debug-only, so a reconciler that silently stopped
    // advancing looked identical to a healthy one at the default info level. Heartbeat
    // every 60th idle cycle instead. Bump if 30s cadence ever makes this noisy.
    let mut idle: u64 = 0;
    loop {
        match one_cycle(src, mbox, cfg, &state).await {
            Ok(delivered) => {
                if delivered > 0 {
                    idle = 0;
                    tracing::info!(source = %src.id, mailbox = %mbox, delivered, "cycle ok");
                } else {
                    if idle % 60 == 0 {
                        tracing::info!(source = %src.id, mailbox = %mbox, idle, "cycle ok (no new)");
                    } else {
                        tracing::debug!(source = %src.id, mailbox = %mbox, "cycle ok (no new)");
                    }
                    idle = idle.wrapping_add(1);
                }
            }
            Err(e) => {
                // `%e` prints only the outermost .context() label, which hid the real
                // cause of a multi-day outage behind the bare string "oauth refresh".
                let chain = format!("{:#}", e);
                tracing::error!(source = %src.id, mailbox = %mbox, error = %chain, "cycle failed");
            }
        }
        tokio::time::sleep(interval).await;
    }
}

async fn one_cycle(src: &Source, mbox: &str, cfg: &Config, state: &State) -> Result<u32> {
    let addr = format!("{}:{}", src.imap_host, src.imap_port);
    let tcp  = TcpStream::connect(&addr).await.with_context(|| format!("tcp {}", addr))?;
    let tls  = TlsConnector::from(Arc::new(tls_config()));
    let dns  = rustls::pki_types::ServerName::try_from(src.imap_host.clone())
        .map_err(|_| anyhow!("invalid DNS name {}", src.imap_host))?;
    let tls_stream = tls.connect(dns, tcp).await.context("TLS handshake")?;

    let client = Client::new(tls_stream.compat());

    // Resolve auth (supports new tagged AuthMethod + legacy `oauth` field).
    let auth_method = src.resolve_auth()?;
    let mut session: Session<ImapStream> = match auth_method {
        AuthMethod::Oauth(oauth_ref) => {
            let access = oauth::fetch(&oauth_ref).await.context("oauth refresh")?;
            let auth = XOAuth2 { user: src.email.clone(), token: access.value };
            client
                .authenticate("XOAUTH2", &auth)
                .await
                .map_err(|(e, _)| anyhow!("XOAUTH2 auth failed: {:?}", e))?
        }
        AuthMethod::AppPassword { password_env } => {
            let pw = env::var(&password_env)
                .with_context(|| format!("env var {} unset (App Password for {})", password_env, src.id))?;
            client
                .login(&src.email, &pw)
                .await
                .map_err(|(e, _)| anyhow!("LOGIN auth failed for {}: {:?}", src.email, e))?
        }
    };

    let select = session.select(mbox).await.with_context(|| format!("SELECT {}", mbox))?;
    let uidvalidity = select.uid_validity.unwrap_or(0) as u32;
    let (prev_uv, prev_uid) = state.get_cursor(&src.id, mbox)?;
    let has_cursor = prev_uv != 0 || prev_uid != 0;

    let from_uid = if !has_cursor {
        match &src.initial_since {
            Some(since) => initial_from_uid(&mut session, since, select.uid_next).await?,
            None => 0,
        }
    } else if prev_uv != uidvalidity {
        0
    } else {
        prev_uid
    };

    // SELECT already told us UIDNEXT. When it is not past the cursor there is
    // nothing new, and `UID FETCH <cursor+1>:*` must NOT be sent: per RFC 3501
    // §6.4.8 a range whose start is above the highest UID still matches the
    // LAST message, so every idle cycle re-downloaded that message's full
    // BODY[] (attachments included) only for the `uid <= from_uid` guard below
    // to throw it away -- 2880 times a day at a 30s cadence, each one a
    // message-sized allocation on a 954MiB box under memory pressure.
    if nothing_new(select.uid_next, from_uid) {
        let _ = session.logout().await;
        return Ok(0);
    }

    let count = fetch_and_deliver(&mut session, src, mbox, cfg, state, from_uid, uidvalidity).await?;

    let _ = session.logout().await;
    Ok(count)
}

/// True when the server's UIDNEXT proves no message above `from_uid` exists.
/// A server that omits UIDNEXT gets the FETCH (never skip on missing data).
fn nothing_new(uid_next: Option<u32>, from_uid: u32) -> bool {
    matches!(uid_next, Some(n) if n <= from_uid.saturating_add(1))
}

/// Bounded first-run backfill: `UID SEARCH SINCE <date>` and start from the
/// lowest matching UID, instead of `UID FETCH 1:*` pulling the whole mailbox.
async fn initial_from_uid(session: &mut Session<ImapStream>, since: &str, uid_next: Option<u32>) -> Result<u32> {
    let imap_date = to_imap_date(since)?;
    let query = format!("SINCE {}", imap_date);
    let uids = session.uid_search(&query).await.with_context(|| format!("UID SEARCH {}", query))?;
    Ok(match uids.into_iter().min() {
        Some(min_uid) => min_uid.saturating_sub(1),
        // Nothing matched (e.g. no mail since that date yet) — skip straight
        // to the current end of the mailbox rather than falling back to 0,
        // which would re-trigger a full backfill.
        None => uid_next.unwrap_or(1).saturating_sub(1),
    })
}

/// `"2026-08-10"` -> `"10-Aug-2026"` (IMAP SEARCH date format, RFC 3501 §9).
fn to_imap_date(s: &str) -> Result<String> {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let parts: Vec<&str> = s.split('-').collect();
    let [y, m, d]: [&str; 3] = parts.try_into()
        .map_err(|_| anyhow!("initial_since {:?}: expected YYYY-MM-DD", s))?;
    let year: u32 = y.parse().with_context(|| format!("initial_since {:?}: bad year", s))?;
    let month: usize = m.parse().with_context(|| format!("initial_since {:?}: bad month", s))?;
    let day: u32 = d.parse().with_context(|| format!("initial_since {:?}: bad day", s))?;
    if month == 0 || month > 12 {
        return Err(anyhow!("initial_since {:?}: month out of range", s));
    }
    Ok(format!("{}-{}-{}", day, MONTHS[month - 1], year))
}

async fn fetch_and_deliver(
    session: &mut Session<ImapStream>,
    src: &Source,
    mbox: &str,
    cfg: &Config,
    state: &State,
    from_uid: u32,
    uidvalidity: u32,
) -> Result<u32> {
    let query = format!("{}:*", from_uid.saturating_add(1));
    let mut stream = session.uid_fetch(&query, "(UID ENVELOPE BODY.PEEK[])").await?;

    let mut max_uid = from_uid;
    let mut count = 0u32;

    while let Some(fetch_res) = stream.next().await {
        let fetch = fetch_res?;
        let uid = match fetch.uid { Some(u) => u, None => continue };
        if uid <= from_uid { continue; }

        let envelope = fetch.envelope();
        let subject = envelope
            .and_then(|e| e.subject.as_ref())
            .map(|b| String::from_utf8_lossy(b).into_owned())
            .unwrap_or_else(|| "(no subject)".into());
        let msg_id = envelope
            .and_then(|e| e.message_id.as_ref())
            .map(|b| String::from_utf8_lossy(b).into_owned());

        let raw = fetch.body().ok_or_else(|| anyhow!("UID {} missing BODY[]", uid))?.to_vec();

        for target_name in &src.targets {
            if let Some(t) = cfg.delivery_targets.get(target_name) {
                // Dedup gate: messages with no parseable Message-ID can't be
                // deduped, so fall back to always delivering them rather than
                // silently dropping them.
                if let Some(mid) = msg_id.as_deref() {
                    match state.was_delivered(&src.id, target_name, mid) {
                        Ok(true) => {
                            tracing::debug!(source = %src.id, mailbox = %mbox, uid, target = %target_name, "already delivered, skipping");
                            continue;
                        }
                        Ok(false) => {}
                        Err(e) => tracing::warn!(source = %src.id, mailbox = %mbox, uid, target = %target_name, error = %format!("{:#}", e), "dedup lookup failed, delivering anyway"),
                    }
                }

                match deliver::deliver_raw(
                    target_name, t,
                    &src.deliver_envelope_from,
                    &src.deliver_envelope_to,
                    &subject,
                    &raw,
                ).await {
                    Ok(()) => {
                        tracing::info!(source = %src.id, mailbox = %mbox, uid, target = %target_name, "delivered");
                        if let Some(mid) = msg_id.as_deref() {
                            if let Err(e) = state.record_delivered(&src.id, target_name, mid) {
                                tracing::warn!(source = %src.id, mailbox = %mbox, uid, target = %target_name, error = %format!("{:#}", e), "record delivered failed");
                            }
                        }
                    }
                    Err(e) => {
                        let err = format!("{:#}", e);
                        tracing::error!(source = %src.id, mailbox = %mbox, uid, target = %target_name, error = %err, "deliver failed");
                    }
                }
            }
        }

        if uid > max_uid { max_uid = uid; }
        count += 1;
        if count >= cfg.defaults.fetch_batch { break; }
    }
    drop(stream);

    if max_uid > from_uid {
        state.set_cursor(&src.id, mbox, uidvalidity, max_uid)?;
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_fetch_only_when_uidnext_proves_nothing_new() {
        assert!(nothing_new(Some(101), 100), "UIDNEXT = cursor+1: nothing new");
        assert!(nothing_new(Some(1), 0), "empty mailbox, no cursor");
        assert!(!nothing_new(Some(102), 100), "one new message must be fetched");
        assert!(!nothing_new(Some(5), 0), "uidvalidity reset to 0 must refetch");
        assert!(!nothing_new(None, 100), "no UIDNEXT: never skip");
        assert!(nothing_new(Some(u32::MAX), u32::MAX), "no overflow at the top");
    }

    #[test]
    fn imap_date_format() {
        assert_eq!(to_imap_date("2026-08-10").unwrap(), "10-Aug-2026");
    }
}
