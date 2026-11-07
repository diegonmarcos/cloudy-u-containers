//! Dynamic cross-cutting filter views — the `A*`-`F*` axes (size, time,
//! read-state, attachments, priority, sender).
//!
//! Routing is owned entirely by the native Sieve (`_shared/lib/derive-mail-rules.ts`
//! `::toSieve`): every inbound email lands in INBOX plus exactly one numeric
//! `1*`-`9*` category folder. This module never routes and never touches
//! keywords.
//!
//! It maintains membership of the filter mailboxes over the messages already
//! living in the numeric folders, using JMAP multi-mailbox membership — the
//! existing message is added to the view mailbox, so there are no copies and
//! no keyword changes. Membership is both added AND removed on every poll,
//! for every view, so a view added to the rules later still backfills onto
//! existing mail (see the sentinel note in [`maintain_filters`]).

use anyhow::Result;
use regex::Regex;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

use crate::jmap::{BodyPart, Client, Email, Mailbox};
use crate::rules::{Predicate, PredicateNode, Rules, View};

/// Emails per `Email/get` / `Email/set` call.
const BATCH_SIZE: usize = 100;

pub const EMAIL_PROPS: &[&str] = &[
    "size",
    "receivedAt",
    "keywords",
    "mailboxIds",
    "hasAttachment",
    "bodyStructure",
    "from",
];

fn header<'a>(em: &'a Email, name: &str) -> Option<&'a str> {
    em.headers.get(&format!("header:{name}:asText")).and_then(Value::as_str)
}

fn from_email(em: &Email) -> String {
    em.from.first().and_then(|a| a.email.as_deref()).unwrap_or("").to_ascii_lowercase()
}

fn from_domain(em: &Email) -> String {
    from_email(em).rsplit('@').next().unwrap_or("").to_string()
}

/// Header names every `HeaderContains` atom across `views` references, as
/// `header:X:asText` JMAP property strings — appended to [`EMAIL_PROPS`] so
/// adding a header-based view never needs a matching Rust edit here.
pub fn headers_referenced<'a>(preds: impl Iterator<Item = &'a PredicateNode>) -> Vec<String> {
    fn walk(node: &PredicateNode, out: &mut HashSet<String>) {
        match node {
            PredicateNode::AnyOf(children) | PredicateNode::AllOf(children) => {
                children.iter().for_each(|c| walk(c, out));
            }
            PredicateNode::Not(child) => walk(child, out),
            PredicateNode::Atom(Predicate::HeaderContains { header, .. }) => {
                out.insert(header.clone());
            }
            PredicateNode::Atom(_) => {}
        }
    }
    let mut names = HashSet::new();
    for p in preds {
        walk(p, &mut names);
    }
    names.into_iter().map(|h| format!("header:{h}:asText")).collect()
}

/// True if the email has a real (non-inline) attachment.
///
/// Prefers JMAP's `hasAttachment` when the server sent it; otherwise walks
/// `bodyStructure` for a part with an `attachment` disposition or a filename.
fn has_attachment(em: &Email) -> bool {
    match em.has_attachment {
        Some(v) => v,
        None => !attachment_types(em).is_empty(),
    }
}

/// MIME `type`s of the attachment parts in `bodyStructure`, lowercased.
fn attachment_types(em: &Email) -> HashSet<String> {
    fn walk(part: &BodyPart, out: &mut HashSet<String>) {
        let disp = part.disposition.as_deref().unwrap_or("").to_ascii_lowercase();
        if disp == "attachment" || part.name.is_some() {
            if let Some(t) = &part.mime_type {
                out.insert(t.to_ascii_lowercase());
            }
        }
        for sub in &part.sub_parts {
            walk(sub, out);
        }
    }
    let mut out = HashSet::new();
    if let Some(root) = &em.body_structure {
        walk(root, &mut out);
    }
    out
}

/// Parse a JMAP UTCDate (RFC 3339, e.g. `2026-06-18T10:20:30Z`) to epoch secs.
fn parse_utcdate(value: &str) -> Option<f64> {
    let v = value.trim();
    if v.is_empty() {
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(v) {
        return Some(dt.timestamp() as f64);
    }
    // The Python accepted an offset-less timestamp via fromisoformat; keep
    // that tolerance rather than silently dropping such a message from every
    // time-window view.
    chrono::DateTime::parse_from_rfc3339(&format!("{v}Z"))
        .ok()
        .map(|dt| dt.timestamp() as f64)
}

/// Evaluate a predicate tree (combinators + atoms) against an `Email/get`
/// object.
pub fn email_matches(em: &Email, node: &PredicateNode, now: f64) -> bool {
    match node {
        PredicateNode::AnyOf(children) => children.iter().any(|c| email_matches(em, c, now)),
        PredicateNode::AllOf(children) => children.iter().all(|c| email_matches(em, c, now)),
        PredicateNode::Not(child) => !email_matches(em, child, now),
        PredicateNode::Atom(atom) => atom_matches(em, atom, now),
    }
}

/// Evaluate one leaf predicate against an `Email/get` object.
///
/// Size views must tile the axis exactly once. All three size predicates are
/// half-open `[lo, hi)` so a message on a boundary lands in exactly one
/// bucket; `SizeRange` used to be fully closed, so a message of exactly
/// 10485760 bytes matched both "Medium" `[1MB,10MB]` and "Large" `[10MB,inf)`
/// and was filed into two folders.
fn atom_matches(em: &Email, predicate: &Predicate, now: f64) -> bool {
    let size = em.size;
    match predicate {
        Predicate::SizeMin { bytes } => size >= *bytes,
        Predicate::SizeMax { bytes } => size < *bytes,
        Predicate::SizeRange { min, max } => size >= *min && size < *max,
        Predicate::NewerThanHours { hours } => match em
            .received_at
            .as_deref()
            .and_then(parse_utcdate)
        {
            Some(ts) => (now - ts) <= hours * 3600.0,
            None => false,
        },
        // Undated mail matches neither side of the pair, same as
        // NewerThanHours — an unparseable date shouldn't silently join
        // every "everything older" catch-all either.
        Predicate::OlderThanHours { hours } => match em
            .received_at
            .as_deref()
            .and_then(parse_utcdate)
        {
            Some(ts) => (now - ts) > hours * 3600.0,
            None => false,
        },
        Predicate::Unread => !em.keywords.get("$seen").copied().unwrap_or(false),
        Predicate::Read => em.keywords.get("$seen").copied().unwrap_or(false),
        Predicate::HasAttachment => has_attachment(em),
        Predicate::NoAttachment => !has_attachment(em),
        Predicate::AttachType { values } => {
            let types = attachment_types(em);
            values
                .iter()
                .any(|v| types.contains(&v.to_ascii_lowercase()))
        }
        Predicate::HeaderContains { header: name, values } => match header(em, name) {
            Some(h) => {
                let hl = h.to_ascii_lowercase();
                values.iter().any(|v| hl.contains(&v.to_ascii_lowercase()))
            }
            None => false,
        },
        Predicate::HasFlag { flag } => em.keywords.get(flag).copied().unwrap_or(false),
        Predicate::FromDomain { values } => {
            let d = from_domain(em);
            values.iter().any(|v| d == v.to_ascii_lowercase())
        }
        Predicate::FromDomainSuffix { values } => {
            let d = from_domain(em);
            values.iter().any(|v| d.ends_with(v.to_ascii_lowercase().as_str()))
        }
    }
}

/// Reconcile membership of every filter-view mailbox. Returns emails updated.
pub fn maintain_filters(
    client: &Client,
    rules: &Rules,
    name_to_id: &HashMap<String, String>,
    mailboxes: &[Mailbox],
) -> Result<usize> {
    let views = &rules.filters.views;
    if views.is_empty() {
        return Ok(0);
    }

    let src_re = Regex::new(&rules.filters.source_folder_regex)?;

    // 1. Source mailboxes = those whose NAME matches the regex, PLUS the
    //    children of any such mailbox.
    //
    // The regex is `^[0-9]` — it matches the numeric category folders. Group
    // children (folder_groups: "31 Cloud - Reports & CI" -> "GH Workflows")
    // are leaf-named, so they never match it, and every message filed into
    // one was invisible to all A-F views. Matching a child by its PARENT
    // keeps the rule "mail in a numeric category is in scope" true whether
    // that category is flat or has a sub-level.
    let matched_parents: HashSet<&str> = mailboxes
        .iter()
        .filter(|mb| src_re.is_match(&mb.name))
        .map(|mb| mb.id.as_str())
        .collect();
    let source_ids: Vec<String> = mailboxes
        .iter()
        .filter(|mb| {
            src_re.is_match(&mb.name)
                || mb.parent_id.as_deref().is_some_and(|p| matched_parents.contains(p))
        })
        .map(|mb| mb.id.clone())
        .collect();
    if source_ids.is_empty() {
        return Ok(0);
    }

    // View folder name -> mailbox id (skip views whose mailbox isn't created).
    let view_ids: HashMap<&str, &str> = views
        .iter()
        .filter_map(|v| {
            name_to_id
                .get(&v.folder)
                .map(|id| (v.folder.as_str(), id.as_str()))
        })
        .collect();
    if view_ids.is_empty() {
        return Ok(0);
    }

    // Every view is evaluated for every message, every poll.
    //
    // There used to be a "skip static views" optimisation here: views declaring
    // `volatile: false` (size, attachments, sender) are properties of the
    // message that never change, so membership of the `partition_axis` views
    // was used as a sentinel meaning "static views already computed for this
    // message" and they were skipped on later polls.
    //
    // That sentinel is subtly wrong and it bit us for real. It records THAT
    // some static views were computed, not WHICH — so the moment a new static
    // view is added to the rules, every message already carrying the sentinel
    // skips it forever and the new folder stays permanently, silently empty.
    // MEASURED on oci-mail 2026-08-25, after adding the Dd + F* views:
    // "Dd No attachments" held 46 of the 4425 messages it should have (only
    // the ones that happened to arrive after the deploy), and Fb/Fe/Fi held
    // 38 between them for the same reason. Exactly the class of silent,
    // looks-like-it-works failure the rest of this engine is written to avoid.
    //
    // Removing it costs almost nothing: the expensive part of a poll is the
    // JMAP round-trips (`email_query_in` + `email_get` below), and those
    // fetch every message regardless of this flag. All the sentinel ever
    // saved was in-memory predicate evaluation — string compares and a
    // bodyStructure walk, microseconds per message.
    //
    // `partition_axis` stays in the rules data: the tiling invariant it
    // describes is still genuinely worth asserting, and
    // 9_others/test/test_mail_filter_views_partition.sh asserts it in CI.
    // It is simply no longer used to skip work here.

    // 2. Emails to reconcile = those in a source folder, UNION those already
    //    sitting in a view folder.
    //
    // The union half is what makes removal work at all. Membership is only
    // ever re-evaluated for messages this query returns, so scanning just the
    // source folders means a message that LEAVES the source set (its numeric
    // folder was renamed or reaped, it was archived, it was filed elsewhere)
    // is never looked at again and keeps whatever view membership it had
    // forever. MEASURED on oci-mail 2026-08-25: 3668 messages sat in
    // "Ac Small (<1MB)" while belonging to no numeric folder at all —
    // leftovers from the numeric-folder restructure earlier that day. The
    // views looked plausible (Ac showed 4397) while being ~83% stale.
    //
    // Including the view folders costs one extra id-only query and makes the
    // reconcile total: anything in a view but no longer in scope gets its
    // view bits cleared below, because `in_source` is false for it and every
    // `want` evaluates false.
    let mut scan_ids: Vec<String> = source_ids.clone();
    scan_ids.extend(view_ids.values().map(|id| id.to_string()));
    let email_ids = client.email_query_in(&scan_ids, None)?;
    if email_ids.is_empty() {
        return Ok(0);
    }

    // Set form for the per-message "is this still in scope?" test below.
    let source_set: HashSet<&str> = source_ids.iter().map(String::as_str).collect();

    let header_props = headers_referenced(views.iter().map(|v| &v.predicate));
    let props: Vec<&str> = EMAIL_PROPS
        .iter()
        .copied()
        .chain(header_props.iter().map(String::as_str))
        .collect();

    let now = crate::now_epoch();
    let mut updates: Map<String, Value> = Map::new();

    for batch in email_ids.chunks(BATCH_SIZE) {
        let emails = client.email_get(batch, &props)?;

        for em in &emails {
            // Membership is edited as RFC 8620 patch paths (`mailboxIds/<id>`),
            // never by writing the whole `mailboxIds` map back: a whole-map write
            // is a read-modify-write that silently drops any membership (Inbox
            // included) changed between the Email/get and the Email/set.
            let mut patch: Map<String, Value> = Map::new();
            let mut desired: HashMap<String, bool> = em.mailbox_ids.clone();

            // Only emit an update if a VIEW-mailbox bit actually flipped.
            // `desired` starts as an exact copy of the current membership and
            // this loop is the only thing that touches it, so tracking the
            // flips directly is equivalent to diffing the two sets — and it
            // guarantees non-view membership (numeric folders, INBOX) is never
            // rewritten just because it was re-serialised.
            // A message outside the source folders is out of scope for every
            // view, whatever its predicates would say — it only appears in
            // this batch so its stale view bits can be cleared.
            let in_source = em.mailbox_ids.keys().any(|id| source_set.contains(id.as_str()));

            let mut changed = false;
            for view in views {
                let Some(vid) = view_ids.get(view.folder.as_str()).copied() else {
                    continue;
                };
                let want = in_source && email_matches(em, &view.predicate, now);
                let have = desired.contains_key(vid);
                if want && !have {
                    desired.insert(vid.to_string(), true);
                    patch.extend(crate::inbox_guard::membership_patch(&[vid], &[]));
                    changed = true;
                } else if !want && have {
                    desired.remove(vid);
                    patch.extend(crate::inbox_guard::membership_patch(&[], &[vid]));
                    changed = true;
                }
            }

            if changed {
                updates.insert(em.id.clone(), Value::Object(patch));
            }
        }
    }

    let mut total = 0usize;
    if !updates.is_empty() {
        let items: Vec<(String, Value)> = updates.into_iter().collect();
        for chunk in items.chunks(BATCH_SIZE) {
            let patch: Map<String, Value> = chunk.iter().cloned().collect();
            let result = client.email_set(patch)?;
            total += result.updated.len();
            for (eid, err) in result.not_updated.iter().take(3) {
                tracing::warn!("Filter update failed {eid}: {err}");
            }
        }
    }

    if total > 0 {
        tracing::info!(
            "Filter views: updated membership on {total} emails ({} scanned, {} views)",
            email_ids.len(),
            views.len()
        );
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn email(v: Value) -> Email {
        serde_json::from_value(v).expect("email fixture")
    }

    fn pred(v: Value) -> PredicateNode {
        serde_json::from_value(v).expect("predicate fixture")
    }

    #[test]
    fn size_buckets_tile_exactly_once() {
        // The regression that filed a 10MB message into two folders: the three
        // size views must partition the axis, so every size matches exactly one.
        let views = [
            pred(json!({"type": "size_max",   "bytes": 1048576})),
            pred(json!({"type": "size_range", "min": 1048576, "max": 10485760})),
            pred(json!({"type": "size_min",   "bytes": 10485760})),
        ];
        for size in [0u64, 1, 1048575, 1048576, 1048577, 10485759, 10485760, 10485761, 1 << 30] {
            let em = email(json!({"id": "e", "size": size}));
            let hits = views.iter().filter(|p| email_matches(&em, p, 0.0)).count();
            assert_eq!(hits, 1, "size {size} matched {hits} buckets, expected exactly 1");
        }
    }

    #[test]
    fn unread_is_absence_of_seen() {
        let seen = email(json!({"id": "e", "keywords": {"$seen": true}}));
        let unseen = email(json!({"id": "e", "keywords": {"$flagged": true}}));
        let none = email(json!({"id": "e"}));
        let p = pred(json!({"type": "unread"}));
        assert!(!email_matches(&seen, &p, 0.0));
        assert!(email_matches(&unseen, &p, 0.0));
        assert!(email_matches(&none, &p, 0.0));
    }

    #[test]
    fn newer_than_hours_uses_received_at() {
        let p = pred(json!({"type": "newer_than_hours", "hours": 24}));
        // 2026-06-18T10:20:30Z
        let em = email(json!({"id": "e", "receivedAt": "2026-06-18T10:20:30Z"}));
        let ts = parse_utcdate("2026-06-18T10:20:30Z").unwrap();
        assert!(email_matches(&em, &p, ts + 3600.0), "1h old must match 24h window");
        assert!(email_matches(&em, &p, ts + 24.0 * 3600.0), "exactly 24h is inclusive");
        assert!(!email_matches(&em, &p, ts + 24.0 * 3600.0 + 1.0), "25h must not match");
        // An unparseable/absent date must not silently join every time view.
        let undated = email(json!({"id": "e"}));
        assert!(!email_matches(&undated, &p, ts));
    }

    #[test]
    fn older_than_hours_is_exact_complement_of_newer() {
        let newer = pred(json!({"type": "newer_than_hours", "hours": 168}));
        let older = pred(json!({"type": "older_than_hours", "hours": 168}));
        let ts = parse_utcdate("2026-06-18T10:20:30Z").unwrap();
        let em = email(json!({"id": "e", "receivedAt": "2026-06-18T10:20:30Z"}));
        for now in [ts, ts + 168.0 * 3600.0, ts + 168.0 * 3600.0 + 1.0, ts + 30.0 * 24.0 * 3600.0] {
            let hits = [&newer, &older].iter().filter(|p| email_matches(&em, p, now)).count();
            assert_eq!(hits, 1, "now={now} matched {hits} of {{newer,older}}, expected exactly 1");
        }
        // Undated mail must not silently join the "everything older" catch-all.
        let undated = email(json!({"id": "e"}));
        assert!(!email_matches(&undated, &older, ts));
    }

    #[test]
    fn read_is_exact_complement_of_unread() {
        let seen = email(json!({"id": "e", "keywords": {"$seen": true}}));
        let unseen = email(json!({"id": "e"}));
        let read = pred(json!({"type": "read"}));
        assert!(email_matches(&seen, &read, 0.0));
        assert!(!email_matches(&unseen, &read, 0.0));
    }

    #[test]
    fn no_attachment_is_exact_complement_of_has_attachment() {
        let with = email(json!({"id": "e", "hasAttachment": true}));
        let without = email(json!({"id": "e", "hasAttachment": false}));
        let no_attach = pred(json!({"type": "no_attachment"}));
        assert!(!email_matches(&with, &no_attach, 0.0));
        assert!(email_matches(&without, &no_attach, 0.0));
    }

    #[test]
    fn header_contains_atom() {
        let p = pred(json!({"type": "header_contains", "header": "X-Spam-Status", "values": ["Yes"]}));
        let spam = email(json!({"id": "e", "header:X-Spam-Status:asText": "Yes, score=9.1"}));
        let clean = email(json!({"id": "e", "header:X-Spam-Status:asText": "No, score=0.1"}));
        let absent = email(json!({"id": "e"}));
        assert!(email_matches(&spam, &p, 0.0));
        assert!(!email_matches(&clean, &p, 0.0));
        assert!(!email_matches(&absent, &p, 0.0));
    }

    #[test]
    fn has_flag_atom() {
        let p = pred(json!({"type": "has_flag", "flag": "Sec_type:Login_Alert"}));
        let flagged = email(json!({"id": "e", "keywords": {"Sec_type:Login_Alert": true}}));
        let other = email(json!({"id": "e", "keywords": {"$seen": true}}));
        assert!(email_matches(&flagged, &p, 0.0));
        assert!(!email_matches(&other, &p, 0.0));
    }

    #[test]
    fn star_is_the_lowercase_dollar_flagged_keyword() {
        // The owner's star. cloud-mail writes `keywords/$flagged` -- the IANA
        // keyword, RFC 8621 4.1.1, lowercase and `$`-prefixed (see its own
        // StarOnTheWireTest). `Ea    Important` references that exact string
        // through predicates.important_flags, and this lookup is a plain
        // case-sensitive map get: `$Flagged` would be stored happily by the
        // server and matched by NOBODY, leaving a star that silently files
        // nothing. Assert the evaluator, not the spelling in the JSON.
        let p = pred(json!({"type": "has_flag", "flag": "$flagged"}));
        let starred = email(json!({"id": "e", "keywords": {"$flagged": true}}));
        let read_only = email(json!({"id": "e", "keywords": {"$seen": true}}));
        let no_keywords = email(json!({"id": "e"}));
        let wrong_case = email(json!({"id": "e", "keywords": {"$Flagged": true}}));
        // JMAP models "unstar" as REMOVING the key; a false value is the other
        // shape a client could leave behind, and it must not count as starred.
        let unstarred = email(json!({"id": "e", "keywords": {"$flagged": false}}));
        assert!(email_matches(&starred, &p, 0.0), "a starred message must match");
        assert!(!email_matches(&read_only, &p, 0.0));
        assert!(!email_matches(&no_keywords, &p, 0.0));
        assert!(!email_matches(&unstarred, &p, 0.0), "$flagged:false is not starred");
        assert!(
            !email_matches(&wrong_case, &p, 0.0),
            "keyword matching is case-sensitive: if this ever passes, the view would \
             also match keywords no client writes, and the real one may be missed"
        );
    }

    #[test]
    fn starring_moves_a_message_from_normal_to_important() {
        // The priority axis is hand-tiled: Eb Normal is NOT(Ec) AND NOT(Ea).
        // Adding a flag to Ea alone would put a starred message in BOTH
        // folders, so the two predicates share one list in the rules data
        // (predicates.important_flags). This is that pair's shape.
        let important = json!({"any_of": [{"type": "has_flag", "flag": "$flagged"}]});
        let ea = pred(important.clone());
        let eb = pred(json!({"all_of": [{"not": important}]}));
        let starred = email(json!({"id": "e", "keywords": {"$flagged": true}}));
        let plain = email(json!({"id": "e"}));
        for (em, label) in [(&starred, "starred"), (&plain, "plain")] {
            let hits = [&ea, &eb].iter().filter(|p| email_matches(em, p, 0.0)).count();
            assert_eq!(hits, 1, "{label} matched {hits} of {{Ea, Eb}}, expected exactly 1");
        }
        assert!(email_matches(&starred, &ea, 0.0), "starred belongs to Important");
        assert!(email_matches(&plain, &eb, 0.0), "unstarred belongs to Normal");
    }

    #[test]
    fn from_domain_atoms() {
        let em = email(json!({"id": "e", "from": [{"email": "Alerts@GitHub.com"}]}));
        let exact = pred(json!({"type": "from_domain", "values": ["github.com"]}));
        let suffix = pred(json!({"type": "from_domain_suffix", "values": [".github.com"]}));
        let wrong = pred(json!({"type": "from_domain", "values": ["gitlab.com"]}));
        assert!(email_matches(&em, &exact, 0.0));
        assert!(!email_matches(&em, &suffix, 0.0), "exact domain must not match a suffix that requires a subdomain");
        assert!(!email_matches(&em, &wrong, 0.0));
        let sub = email(json!({"id": "e", "from": [{"email": "noreply@notify.github.com"}]}));
        assert!(email_matches(&sub, &suffix, 0.0));
        let no_from = email(json!({"id": "e"}));
        assert!(!email_matches(&no_from, &exact, 0.0));
    }

    #[test]
    fn combinators_recurse() {
        let any = pred(json!({"any_of": [{"type": "has_flag", "flag": "a"}, {"type": "has_flag", "flag": "b"}]}));
        let all = pred(json!({"all_of": [{"type": "has_flag", "flag": "a"}, {"type": "has_flag", "flag": "b"}]}));
        let not_a = pred(json!({"not": {"type": "has_flag", "flag": "a"}}));
        let both = email(json!({"id": "e", "keywords": {"a": true, "b": true}}));
        let only_a = email(json!({"id": "e", "keywords": {"a": true}}));
        let neither = email(json!({"id": "e"}));
        assert!(email_matches(&both, &any, 0.0) && email_matches(&only_a, &any, 0.0) && !email_matches(&neither, &any, 0.0));
        assert!(email_matches(&both, &all, 0.0) && !email_matches(&only_a, &all, 0.0));
        assert!(!email_matches(&only_a, &not_a, 0.0) && email_matches(&neither, &not_a, 0.0));
    }

    #[test]
    fn empty_any_of_is_always_false_placeholder() {
        // Fj Personal's placeholder predicate until real addresses exist.
        let p = pred(json!({"any_of": []}));
        let anything = email(json!({"id": "e", "from": [{"email": "a@b.com"}]}));
        assert!(!email_matches(&anything, &p, 0.0));
    }

    #[test]
    fn all_of_not_over_many_children_is_the_complement() {
        // Fz Others' shape: all_of[not(child)...] over every other F view.
        let a = pred(json!({"type": "from_domain", "values": ["a.com"]}));
        let b = pred(json!({"type": "from_domain", "values": ["b.com"]}));
        let complement = pred(json!({"all_of": [
            {"not": {"type": "from_domain", "values": ["a.com"]}},
            {"not": {"type": "from_domain", "values": ["b.com"]}}
        ]}));
        let from_a = email(json!({"id": "e", "from": [{"email": "x@a.com"}]}));
        let from_c = email(json!({"id": "e", "from": [{"email": "x@c.com"}]}));
        assert!(email_matches(&from_a, &a, 0.0) && !email_matches(&from_a, &complement, 0.0));
        assert!(!email_matches(&from_c, &a, 0.0) && !email_matches(&from_c, &b, 0.0) && email_matches(&from_c, &complement, 0.0));
    }

    #[test]
    fn unknown_combinator_key_falls_through_to_atom_error() {
        // Not "any_of"/"all_of"/"not" and not a valid atom `type` either —
        // must fail to parse, not silently become a no-op predicate.
        let bad: Result<PredicateNode, _> = serde_json::from_value(json!({"any_off": []}));
        assert!(bad.is_err());
    }

    #[test]
    fn attachment_falls_back_to_body_structure() {
        let p = pred(json!({"type": "has_attachment"}));
        // hasAttachment wins when present, even against a matching body.
        let flagged_false = email(json!({
            "id": "e", "hasAttachment": false,
            "bodyStructure": {"type": "application/pdf", "disposition": "attachment"}
        }));
        assert!(!email_matches(&flagged_false, &p, 0.0));
        // Absent -> walk subParts, including a filename with no disposition.
        let nested = email(json!({"id": "e", "bodyStructure": {
            "type": "multipart/mixed",
            "subParts": [
                {"type": "text/plain"},
                {"type": "image/png", "name": "shot.png"}
            ]
        }}));
        assert!(email_matches(&nested, &p, 0.0));
        let inline_only = email(json!({"id": "e", "bodyStructure": {
            "type": "multipart/alternative",
            "subParts": [{"type": "text/plain"}, {"type": "text/html"}]
        }}));
        assert!(!email_matches(&inline_only, &p, 0.0));
    }

    #[test]
    fn attach_type_matches_case_insensitively() {
        let p = pred(json!({"type": "attach_type", "values": ["APPLICATION/PDF"]}));
        let em = email(json!({"id": "e", "bodyStructure": {
            "type": "multipart/mixed",
            "subParts": [{"type": "Application/Pdf", "disposition": "ATTACHMENT"}]
        }}));
        assert!(email_matches(&em, &p, 0.0));
    }

    #[test]
    fn unknown_predicate_type_is_a_load_error() {
        // The whole point of the tagged enum: the Python returned False here
        // and left a permanently empty folder that looked like a working one.
        let bad: Result<Predicate, _> = serde_json::from_value(json!({"type": "size_mn", "bytes": 1}));
        assert!(bad.is_err(), "a typo'd predicate type must fail to parse");
    }
}
