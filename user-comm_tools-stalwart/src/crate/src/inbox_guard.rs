//! The Inbox invariant: EVERY message keeps the `Inbox` mailbox.
//!
//! Owner rule: Inbox is the default tag of all mail, no exception. Every other
//! mailbox on a message (numeric category, `01_No-Alerts`, A*-F* views)
//! is a label ADDED on top of Inbox, never a replacement for it.
//!
//! JMAP `mailboxIds` is the message's COMPLETE membership. Writing it back as a
//! whole map is a read-modify-write: anything that changed between the
//! Email/get and the Email/set (a delivery, another client's label) is
//! overwritten, and a classification then "replaces" Inbox instead of adding to
//! it. Three layers make that impossible here:
//!
//!  1. [`membership_patch`] is the ONLY way this binary edits membership: RFC
//!     8620 patch paths (`mailboxIds/<id>`), so untouched mailboxes are never
//!     rewritten.
//!  2. [`sanitize`] runs inside `Client::email_set`, the single choke point for
//!     every Email/set, and drops any update that would remove Inbox or that
//!     replaces the whole `mailboxIds` map without it. A future rule cannot
//!     strip Inbox, whatever it does.
//!  3. [`maintain_inbox_invariant`] runs every poll and RE-ADDS Inbox to any
//!     message that lost it (from this binary, a client, or a bad rule),
//!     except mail in Sent/Drafts/Trash/Junk/Archive, which the owner placed
//!     there on purpose.

use anyhow::Result;
use serde_json::{json, Map, Value};
use std::collections::HashSet;

use crate::jmap::{Client, Mailbox};
use crate::mailboxes::find_inbox_id;

/// Mailbox roles whose mail is intentionally NOT in Inbox: authored mail
/// (sent/drafts) and mail the owner deleted, spammed or archived by hand.
const EXEMPT_ROLES: &[&str] = &["sent", "drafts", "trash", "junk", "archive"];

/// Patch paths adding `add` and removing `remove` memberships, nothing else.
pub fn membership_patch(add: &[&str], remove: &[&str]) -> Map<String, Value> {
    let mut p = Map::new();
    for id in add {
        p.insert(format!("mailboxIds/{id}"), Value::Bool(true));
    }
    for id in remove {
        if !add.contains(id) {
            p.insert(format!("mailboxIds/{id}"), Value::Null);
        }
    }
    p
}

/// True if this single Email/set update would take the message out of Inbox.
pub fn strips_inbox(update: &Value, inbox_id: &str) -> bool {
    let Some(obj) = update.as_object() else { return false };
    if let Some(v) = obj.get(&format!("mailboxIds/{inbox_id}")) {
        if v.is_null() || v == &Value::Bool(false) {
            return true;
        }
    }
    match obj.get("mailboxIds") {
        // Whole-map write: must still contain Inbox.
        Some(Value::Object(m)) => !m.get(inbox_id).is_some_and(|v| v == &Value::Bool(true)),
        Some(_) => true,
        None => false,
    }
}

/// Drop every update that strips Inbox. Returns the dropped email ids.
pub fn sanitize(updates: &mut Map<String, Value>, inbox_id: &str) -> Vec<String> {
    let bad: Vec<String> = updates
        .iter()
        .filter(|(_, u)| strips_inbox(u, inbox_id))
        .map(|(id, _)| id.clone())
        .collect();
    for id in &bad {
        updates.remove(id);
    }
    bad
}

/// Messages that must have Inbox but do not: members of no exempt mailbox.
fn needs_inbox(mailbox_ids: &std::collections::HashMap<String, bool>, inbox_id: &str, exempt: &HashSet<&str>) -> bool {
    !mailbox_ids.contains_key(inbox_id) && !mailbox_ids.keys().any(|m| exempt.contains(m.as_str()))
}

/// Self-healing pass: re-add Inbox to any message missing it.
pub fn maintain_inbox_invariant(client: &Client, mailboxes: &[Mailbox]) -> Result<usize> {
    let Some(inbox_id) = find_inbox_id(mailboxes) else { return Ok(0) };
    let exempt: HashSet<&str> = mailboxes
        .iter()
        .filter(|m| m.role.as_deref().is_some_and(|r| EXEMPT_ROLES.contains(&r)))
        .map(|m| m.id.as_str())
        .collect();

    // Only the offenders: in some non-exempt mailbox, but NOT in Inbox.
    let mut skip: Vec<&str> = exempt.iter().copied().collect();
    skip.push(inbox_id);
    let ids = client.email_query_filter(&json!({
        "operator": "AND",
        "conditions": [
            { "operator": "NOT", "conditions": [{ "inMailbox": inbox_id }] },
            { "inMailboxOtherThan": skip },
        ],
    }))?;
    if ids.is_empty() {
        return Ok(0);
    }

    let mut updates: Map<String, Value> = Map::new();
    for batch in ids.chunks(100) {
        for em in client.email_get(batch, &["mailboxIds"])? {
            if needs_inbox(&em.mailbox_ids, inbox_id, &exempt) {
                updates.insert(em.id, Value::Object(membership_patch(&[inbox_id], &[])));
            }
        }
    }
    if updates.is_empty() {
        return Ok(0);
    }
    let (ok, bad) = client.email_set_chunked(updates)?;
    tracing::warn!("inbox guard: restored Inbox on {ok} message(s) that had lost it ({bad} failed)");
    Ok(ok)
}

#[cfg(test)]
mod tests {
    use super::*;

    const INBOX: &str = "a";

    #[test]
    fn patch_never_mentions_unrelated_mailboxes() {
        let p = membership_patch(&["ir"], &["i9"]);
        assert_eq!(p.len(), 2);
        assert_eq!(p["mailboxIds/ir"], json!(true));
        assert_eq!(p["mailboxIds/i9"], Value::Null);
        assert!(!p.keys().any(|k| k.ends_with("/a")));
    }

    #[test]
    fn classification_is_additive() {
        // Adding 01 noAlerts must not touch Inbox and must pass the guard.
        let u = Value::Object(membership_patch(&["ir"], &[]));
        assert!(!strips_inbox(&u, INBOX));
    }

    #[test]
    fn replacing_whole_map_without_inbox_is_blocked() {
        assert!(strips_inbox(&json!({"mailboxIds": {"ir": true}}), INBOX));
        assert!(!strips_inbox(&json!({"mailboxIds": {"ir": true, "a": true}}), INBOX));
    }

    #[test]
    fn removing_inbox_is_blocked() {
        assert!(strips_inbox(&json!({"mailboxIds/a": null}), INBOX));
        assert!(strips_inbox(&Value::Object(membership_patch(&["ir"], &[INBOX])), INBOX));
        assert!(!strips_inbox(&json!({"keywords/$seen": true}), INBOX));
    }

    #[test]
    fn sanitize_drops_only_offenders() {
        let mut m = Map::new();
        m.insert("good".into(), json!({"mailboxIds/ir": true}));
        m.insert("bad".into(), json!({"mailboxIds": {"ir": true}}));
        m.insert("bad2".into(), json!({"mailboxIds/a": null}));
        let dropped = sanitize(&mut m, INBOX);
        assert_eq!(m.len(), 1);
        assert!(m.contains_key("good"));
        assert_eq!(dropped.len(), 2);
    }

    #[test]
    fn heal_skips_sent_and_trash_but_restores_labelled_mail() {
        let exempt: HashSet<&str> = ["sent", "trash"].into_iter().collect();
        let mk = |ids: &[&str]| ids.iter().map(|i| (i.to_string(), true)).collect();
        assert!(needs_inbox(&mk(&["ir"]), INBOX, &exempt)); // only noAlerts: restore
        assert!(needs_inbox(&mk(&["ir", "i9"]), INBOX, &exempt));
        assert!(!needs_inbox(&mk(&["a", "ir"]), INBOX, &exempt));
        assert!(!needs_inbox(&mk(&["sent"]), INBOX, &exempt));
        assert!(!needs_inbox(&mk(&["trash", "ir"]), INBOX, &exempt));
    }
}
