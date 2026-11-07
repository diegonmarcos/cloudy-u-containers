//! Minimal JMAP client — only what the sorter needs (RFC 8620 / 8621).
//!
//! Every response is checked for the JMAP `error` method response before the
//! payload is read. The Python indexed straight into `resp[0][1]["list"]` and
//! let the resulting KeyError be swallowed by the poll loop's broad
//! `except Exception`, which turned a server-side error into a silent no-op
//! poll.

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::time::Duration;

use crate::rules::null_default;

/// JMAP servers cap `limit` server-side, so this is a page size, not a total.
pub const PAGE: usize = 500;

#[derive(Debug, Clone, Deserialize)]
pub struct Mailbox {
    pub id: String,
    pub name: String,
    #[serde(rename = "parentId", default, deserialize_with = "null_default")]
    pub parent_id: Option<String>,
    #[serde(default, deserialize_with = "null_default")]
    pub role: Option<String>,
    /// Whether the mailbox appears in a client's default folder list (IMAP
    /// LSUB). Stalwart creates mailboxes UNSUBSCRIBED, so every folder this
    /// sorter made was hidden in clients that only show subscribed folders —
    /// measured 53 of 60 unsubscribed on oci-mail.
    #[serde(rename = "isSubscribed", default, deserialize_with = "null_default")]
    pub is_subscribed: bool,
}

#[derive(Debug, Default, Deserialize)]
pub struct BodyPart {
    #[serde(default, deserialize_with = "null_default")]
    pub disposition: Option<String>,
    #[serde(default, deserialize_with = "null_default")]
    pub name: Option<String>,
    #[serde(rename = "type", default, deserialize_with = "null_default")]
    pub mime_type: Option<String>,
    #[serde(rename = "subParts", default, deserialize_with = "null_default")]
    pub sub_parts: Vec<BodyPart>,
}

#[derive(Debug, Default, Deserialize)]
pub struct EmailAddress {
    #[serde(default, deserialize_with = "null_default")]
    pub email: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct Email {
    pub id: String,
    #[serde(default, deserialize_with = "null_default")]
    pub size: u64,
    #[serde(rename = "receivedAt", default, deserialize_with = "null_default")]
    pub received_at: Option<String>,
    /// JMAP keyword sets are `{name: true}`; absence means unset.
    #[serde(default, deserialize_with = "null_default")]
    pub keywords: HashMap<String, bool>,
    #[serde(rename = "mailboxIds", default, deserialize_with = "null_default")]
    pub mailbox_ids: HashMap<String, bool>,
    #[serde(rename = "hasAttachment", default, deserialize_with = "null_default")]
    pub has_attachment: Option<bool>,
    #[serde(rename = "bodyStructure", default, deserialize_with = "null_default")]
    pub body_structure: Option<BodyPart>,
    #[serde(default, deserialize_with = "null_default")]
    pub from: Vec<EmailAddress>,
    /// Catches every `header:X:asText`-shaped property a view's predicate
    /// asked for (see `filters::headers_referenced`) — header names are
    /// data-driven, so a fixed field per header would need a Rust edit every
    /// time a view adds one.
    #[serde(flatten)]
    pub headers: Map<String, Value>,
}

/// Response shape shared by `Mailbox/set` and `Email/set`.
#[derive(Debug, Default, Deserialize)]
pub struct SetResponse {
    /// Part of the JMAP `*/set` response contract; this binary only creates
    /// mailboxes (whose ids it re-fetches) so nothing reads it today.
    #[allow(dead_code)]
    #[serde(default, deserialize_with = "null_default")]
    pub created: Map<String, Value>,
    #[serde(default, deserialize_with = "null_default")]
    pub updated: Map<String, Value>,
    #[serde(default, deserialize_with = "null_default")]
    pub destroyed: Vec<String>,
    #[serde(rename = "notCreated", default, deserialize_with = "null_default")]
    pub not_created: Map<String, Value>,
    #[serde(rename = "notUpdated", default, deserialize_with = "null_default")]
    pub not_updated: Map<String, Value>,
    #[serde(rename = "notDestroyed", default, deserialize_with = "null_default")]
    pub not_destroyed: Map<String, Value>,
}

pub struct Client {
    http: reqwest::blocking::Client,
    base_url: String,
    api_url: String,
    auth: String,
    account_id: String,
    /// Armed once per poll; `email_set` refuses any update that strips it.
    inbox_id: std::sync::Mutex<Option<String>>,
}

impl Client {
    pub fn new(base_url: &str, user: &str, password: &str) -> Result<Self> {
        let http = reqwest::blocking::Client::builder()
            // Stalwart's JMAP listener presents a self-signed cert on the
            // docker bridge; verification cannot succeed and the connection
            // never leaves the host. Same reason the Python set CERT_NONE.
            .danger_accept_invalid_certs(true)
            // The Python passed timeout=30 per urlopen. Without it a wedged
            // server hangs the poll loop forever with no log line.
            .timeout(Duration::from_secs(30))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .context("building HTTP client")?;

        let creds = base64::engine::general_purpose::STANDARD
            .encode(format!("{user}:{password}"));

        Ok(Self {
            http,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_url: format!("{}/jmap/", base_url.trim_end_matches('/')),
            auth: format!("Basic {creds}"),
            account_id: String::new(),
            inbox_id: std::sync::Mutex::new(None),
        })
    }

    fn post(&self, url: &str, body: Option<&Value>) -> Result<Value> {
        let req = match body {
            Some(_) => self.http.post(url),
            None => self.http.get(url),
        };
        let req = req
            .header("Authorization", self.auth.as_str())
            .header("Content-Type", "application/json");
        let resp = match body {
            Some(b) => req.json(b).send(),
            None => req.send(),
        }
        .with_context(|| format!("JMAP request to {url} failed"))?;

        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().unwrap_or_default();
            bail!("JMAP {url} returned {status}: {}", text.chars().take(400).collect::<String>());
        }
        resp.json().with_context(|| format!("decoding JMAP response from {url}"))
    }

    /// Fetch the session object and latch the primary mail account id.
    pub fn discover(&mut self) -> Result<()> {
        let session = self.post(&format!("{}/jmap/session", self.base_url), None)?;
        let id = session
            .get("primaryAccounts")
            .and_then(|a| a.get("urn:ietf:params:jmap:mail"))
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("session has no primaryAccounts[urn:ietf:params:jmap:mail]"))?;
        self.account_id = id.to_string();
        tracing::info!("Account ID: {}", self.account_id);
        Ok(())
    }

    /// Issue one method call and return its response arguments.
    fn call_one(&self, name: &str, args: Value) -> Result<Value> {
        let payload = json!({
            "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
            "methodCalls": [[name, args, "0"]],
        });
        let result = self.post(&self.api_url, Some(&payload))?;
        let responses = result
            .get("methodResponses")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("{name}: response has no methodResponses"))?;
        let first = responses
            .first()
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("{name}: empty methodResponses"))?;

        let kind = first.first().and_then(Value::as_str).unwrap_or("");
        let args = first
            .get(1)
            .cloned()
            .ok_or_else(|| anyhow!("{name}: method response has no arguments"))?;
        // A JMAP-level error comes back as ["error", {type, description}, id].
        // Surfacing it here is the difference between "this poll failed and
        // said why" and "this poll quietly did nothing".
        if kind == "error" {
            bail!("{name} failed: {args}");
        }
        Ok(args)
    }

    fn account(&self) -> &str {
        &self.account_id
    }

    pub fn mailbox_get(&self) -> Result<Vec<Mailbox>> {
        let args = self.call_one("Mailbox/get", json!({ "accountId": self.account() }))?;
        let list = args.get("list").cloned().unwrap_or(Value::Null);
        Ok(serde_json::from_value(list).unwrap_or_default())
    }

    pub fn mailbox_set(
        &self,
        create: Option<Map<String, Value>>,
        update: Option<Map<String, Value>>,
        destroy: Option<Vec<String>>,
        on_destroy_remove_emails: bool,
    ) -> Result<SetResponse> {
        let mut args = Map::new();
        args.insert("accountId".into(), json!(self.account()));
        if let Some(c) = create.filter(|m| !m.is_empty()) {
            args.insert("create".into(), Value::Object(c));
        }
        if let Some(u) = update.filter(|m| !m.is_empty()) {
            args.insert("update".into(), Value::Object(u));
        }
        if let Some(d) = destroy.filter(|v| !v.is_empty()) {
            args.insert("destroy".into(), json!(d));
        }
        // JMAP: when false (the default), destroying a non-empty Mailbox fails
        // with `mailboxHasEmail`. cleanup_stale moves mail to INBOX first, but
        // stragglers (and mail visible only via a child) need the override.
        if on_destroy_remove_emails {
            args.insert("onDestroyRemoveEmails".into(), json!(true));
        }
        let resp = self.call_one("Mailbox/set", Value::Object(args))?;
        Ok(serde_json::from_value(resp).unwrap_or_default())
    }

    pub fn email_get(&self, ids: &[String], properties: &[&str]) -> Result<Vec<Email>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let args = self.call_one(
            "Email/get",
            json!({
                "accountId": self.account(),
                "ids": ids,
                "properties": properties,
            }),
        )?;
        let list = args.get("list").cloned().unwrap_or(Value::Null);
        Ok(serde_json::from_value(list).unwrap_or_default())
    }

    /// `Email/set` in batches. Stalwart caps objects per set request
    /// (`maxObjectsInSet`), and a first backfill re-files thousands of messages
    /// at once -- the whole pass then fails with "The number of ids requested
    /// by the client exceeds the maximum" and nothing moves at all. Chunking
    /// also means a rejected batch costs one batch, not the entire run.
    ///
    /// ponytail: 100 to match filters.rs BATCH_SIZE rather than reading
    /// maxObjectsInSet off the session -- one number, already proven against
    /// this server by the views pass, which is exactly why that pass survived
    /// the same backfill that killed routing.
    pub fn email_set_chunked(&self, updates: Map<String, Value>) -> Result<(usize, usize)> {
        const CHUNK: usize = 100;
        let entries: Vec<(String, Value)> = updates.into_iter().collect();
        let (mut ok, mut bad) = (0usize, 0usize);
        for batch in entries.chunks(CHUNK) {
            let patch: Map<String, Value> = batch.iter().cloned().collect();
            let r = self.email_set(patch)?;
            ok += r.updated.len();
            bad += r.not_updated.len();
        }
        Ok((ok, bad))
    }

    pub fn set_inbox_id(&self, id: &str) {
        *self.inbox_id.lock().unwrap() = Some(id.to_string());
    }

    /// Ids matching an arbitrary Email/query filter (paged like `email_query_in`).
    pub fn email_query_filter(&self, filter: &Value) -> Result<Vec<String>> {
        let mut ids: Vec<String> = Vec::new();
        loop {
            let args = self.call_one(
                "Email/query",
                json!({ "accountId": self.account(), "filter": filter, "position": ids.len(), "limit": PAGE }),
            )?;
            let page: Vec<String> = args
                .get("ids")
                .cloned()
                .map(|v| serde_json::from_value(v).unwrap_or_default())
                .unwrap_or_default();
            if page.is_empty() {
                break;
            }
            ids.extend(page);
            if args.get("total").and_then(Value::as_u64).is_some_and(|t| ids.len() as u64 >= t) {
                break;
            }
        }
        Ok(ids)
    }

    /// THE choke point for every Email/set: the Inbox invariant is enforced
    /// here (inbox_guard.rs), so no caller can strip Inbox from a message.
    pub fn email_set(&self, mut updates: Map<String, Value>) -> Result<SetResponse> {
        if let Some(inbox) = self.inbox_id.lock().unwrap().clone() {
            for id in crate::inbox_guard::sanitize(&mut updates, &inbox) {
                tracing::error!("inbox guard: refused an Email/set that would remove Inbox from {id}");
            }
        }
        if updates.is_empty() {
            return Ok(SetResponse::default());
        }
        let resp = self.call_one(
            "Email/set",
            json!({ "accountId": self.account(), "update": updates }),
        )?;
        Ok(serde_json::from_value(resp).unwrap_or_default())
    }

    /// Ids of every email living in at least one of `mailbox_ids`.
    ///
    /// Pages until the result set is exhausted. A previous implementation
    /// issued one query with `limit=2000` and never read `total`, so once the
    /// store grew past 2000 messages it sorted a prefix and reported success —
    /// mail simply stopped being filed, with no error anywhere.
    pub fn email_query_in(&self, mailbox_ids: &[String], limit: Option<usize>) -> Result<Vec<String>> {
        if mailbox_ids.is_empty() {
            return Ok(Vec::new());
        }
        let filter = if mailbox_ids.len() == 1 {
            json!({ "inMailbox": mailbox_ids[0] })
        } else {
            json!({
                "operator": "OR",
                "conditions": mailbox_ids.iter().map(|m| json!({"inMailbox": m})).collect::<Vec<_>>(),
            })
        };

        let mut ids: Vec<String> = Vec::new();
        let mut position = 0usize;
        let mut total: Option<u64> = None;

        loop {
            let want = match limit {
                None => PAGE,
                Some(l) => PAGE.min(l.saturating_sub(ids.len())),
            };
            if want == 0 {
                break;
            }
            let args = self.call_one(
                "Email/query",
                json!({
                    "accountId": self.account(),
                    "filter": filter,
                    "sort": [{ "property": "receivedAt", "isAscending": false }],
                    "position": position,
                    "limit": want,
                }),
            )?;
            let page: Vec<String> = args
                .get("ids")
                .cloned()
                .map(|v| serde_json::from_value(v).unwrap_or_default())
                .unwrap_or_default();
            if total.is_none() {
                total = args.get("total").and_then(Value::as_u64);
            }
            let got = page.len();
            ids.extend(page);
            // Do NOT stop on a short page. `limit` is a REQUEST, and JMAP caps
            // it server-side (RFC 8620 §5.5) — a server capping at 250 while we
            // ask 500 returns a short page every time, so "short page means the
            // end" would stop after the first one and silently drop the rest.
            // Progress is guaranteed instead by got == 0, and bounded above by
            // the server's own `total`.
            if got == 0 {
                break;
            }
            position += got;
            if let Some(t) = total {
                if ids.len() as u64 >= t {
                    break;
                }
            }
        }

        // Truncation must never be silent again.
        match (limit, total) {
            (Some(_), Some(t)) if t > ids.len() as u64 => {
                tracing::warn!("Email/query truncated by caller limit: fetched {} of {t}", ids.len());
            }
            (None, Some(t)) if t != ids.len() as u64 => {
                tracing::warn!("Email/query count mismatch: fetched {}, server total {t}", ids.len());
            }
            _ => {}
        }
        Ok(ids)
    }
}
