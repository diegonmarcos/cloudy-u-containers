//! Re-apply the routing rules to ALL mail, not just mail being delivered.
//!
//! The native Sieve owns routing at delivery. That is correct and stays. But
//! sieve fires exactly once per message and never again, so:
//!
//!   * fixing a rule leaves every already-delivered message misfiled forever;
//!   * adding a rule leaves the new folder holding only future mail.
//!
//! Both bit us on 2026-08-29: `route.junk.spam_flagged` sat at priority 30 and
//! swallowed wg-gesucht mail before the housing rule at 100 could see it, so
//! `24 House` held 1 message while the sorter-maintained `Fi` view — same
//! account, same mail, same predicate — held all 370. The difference was never
//! the rule. It was that views get re-evaluated and routing did not.
//!
//! So routing gets the same treatment the views already get: every poll, over
//! every message in the source scope, add AND remove membership. Two things
//! differ from `filters.rs`, both because routing is a partition and views are
//! not: the rule list is ORDERED (first match wins, mirroring sieve's `stop;`)
//! and the outcome is EXCLUSIVE (exactly one routing folder, never two).
//!
//! ponytail: no separate backfill command. A one-shot "apply to all" is a
//! second code path that drifts from the live one and gets run by hand at 3am;
//! making the steady-state loop idempotent over all mail means the backfill IS
//! the normal poll, and the first poll after a rule change fixes history for
//! free.

use anyhow::Result;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

use crate::filters::{email_matches, headers_referenced};
use crate::jmap;
use crate::rules::Rules;


/// First match wins, mirroring the sieve's `stop;`. `None` means "no rule
/// claimed this message" and the caller must then leave it entirely alone.
fn pick_folder<'a>(
    rules: &'a Rules,
    routing_ids: &HashMap<&'a str, &'a str>,
    em: &jmap::Email,
    in_source: bool,
    now: f64,
) -> Option<&'a str> {
    if !in_source {
        return None;
    }
    rules
        .routing
        .iter()
        .find(|r| email_matches(em, &r.predicate, now))
        .and_then(|r| routing_ids.get(r.folder.as_str()).copied())
}

/// Reconcile every message in scope against the routing rules.
/// Returns how many messages were re-filed.
pub fn maintain_routing(
    client: &jmap::Client,
    rules: &Rules,
    name_to_id: &HashMap<String, String>,
    mailboxes: &[jmap::Mailbox],
) -> Result<usize> {
    if rules.routing.is_empty() {
        return Ok(0);
    }

    // Every folder routing is allowed to touch. Membership outside this set is
    // left strictly alone — the filter views, Inbox, and anything a human
    // filed by hand all live outside it and must survive untouched.
    let mut routing_ids: HashMap<&str, &str> = HashMap::new();
    for r in &rules.routing {
        if let Some(id) = name_to_id.get(&r.folder) {
            routing_ids.insert(r.folder.as_str(), id.as_str());
        }
    }
    // The junk folder is managed even though no routing entry targets it: the
    // junk rule matches on headers (the spam heuristic), and the legacy emitter
    // only emits from_domain routes, so `93 Junk` never appears in routing[].
    // Without this the pass could add `24 House` but not take `93 Junk` away,
    // leaving a curated sender tagged both -- which is exactly what happened to
    // the wg-gesucht mail. Removing it is provable: a curated route outranks the
    // spam heuristic (priority 100 vs 150), which is the whole point of the
    // ordering fix. This keeps 93 in step with the Ec view's carve-out.
    if let Some(junk) = rules.folders.get("junk") {
        if let Some(id) = name_to_id.get(junk) {
            routing_ids.insert(junk.as_str(), id.as_str());
        }
    }

    if routing_ids.is_empty() {
        tracing::warn!("routing: no target folder exists yet — skipping");
        return Ok(0);
    }
    let routing_id_set: HashSet<&str> = routing_ids.values().copied().collect();

    // Same source scope as the views (`^Inbox$`): every message lands in Inbox
    // as well as its category folder, so Inbox is the superset of all mail.
    let src_re = regex::Regex::new(&rules.filters.source_folder_regex)?;
    let source_ids: Vec<String> = mailboxes
        .iter()
        .filter(|mb| src_re.is_match(&mb.name))
        .map(|mb| mb.id.clone())
        .collect();
    if source_ids.is_empty() {
        tracing::warn!("routing: no source mailbox matched — skipping");
        return Ok(0);
    }

    // Scan the source plus the routing targets, so a message that no longer
    // belongs in a folder is seen and removed, not just left there.
    let mut scan_ids = source_ids.clone();
    scan_ids.extend(routing_id_set.iter().map(|id| id.to_string()));
    let email_ids = client.email_query_in(&scan_ids, None)?;
    if email_ids.is_empty() {
        return Ok(0);
    }

    let source_set: HashSet<&str> = source_ids.iter().map(String::as_str).collect();
    // Deliberately NOT filters::EMAIL_PROPS. Routing predicates are sender and
    // header tests, so fetching `size`/`keywords`/`hasAttachment` is waste, and
    // `bodyStructure` -- the full MIME tree of every message -- is the single
    // most expensive property JMAP will hand back. Over an Inbox this size that
    // is the difference between a cheap pass and doubling the sorter's IO on a
    // 2-core box that already sits at psi io full ~15%.
    let header_props = headers_referenced(rules.routing.iter().map(|r| &r.predicate));
    let props: Vec<&str> = ["mailboxIds", "from"]
        .into_iter()
        .chain(header_props.iter().map(String::as_str))
        .collect();

    let now = crate::now_epoch();
    let mut updates: Map<String, Value> = Map::new();
    let mut unmatched = 0usize;

    for batch in email_ids.chunks(100) {
        for em in client.email_get(batch, &props)? {
            let in_source = em.mailbox_ids.keys().any(|id| source_set.contains(id.as_str()));

            // First match wins, exactly like the sieve's `stop;`. The list
            // arrives in priority order from the generator.
            let want: Option<&str> = pick_folder(rules, &routing_ids, &em, in_source, now);

            // NO MATCH => LEAVE THE MESSAGE ALONE. Deliberately not
            // `routing_default`, and deliberately not "clear the routing bits".
            //
            // This list is NOT the whole sieve. The generator emits only the
            // `from_domain` routes here (38 of them), while the sieve also
            // routes on subject and headers. A message filed by one of those
            // invisible rules matches nothing in this list, so defaulting it
            // would sweep it into the fallback folder and silently undo a
            // correct decision -- across an Inbox this size, thousands of them.
            // A backfill may only ever ADD what it can positively prove.
            let Some(want) = want else {
                if in_source {
                    unmatched += 1;
                }
                continue;
            };

            let mut desired = em.mailbox_ids.clone();
            let mut patch: Map<String, Value> = Map::new();
            let mut changed = false;
            for rid in &routing_id_set {
                let should = want == *rid;
                if desired.contains_key(*rid) != should {
                    if should {
                        desired.insert((*rid).to_string(), true);
                        patch.extend(crate::inbox_guard::membership_patch(&[*rid], &[]));
                    } else {
                        desired.remove(*rid);
                        patch.extend(crate::inbox_guard::membership_patch(&[], &[*rid]));
                    }
                    changed = true;
                }
            }
            if changed {
                updates.insert(em.id.clone(), Value::Object(patch));
            }
        }
    }

    if updates.is_empty() {
        return Ok(0);
    }
    let n = updates.len();
    let (ok, bad) = client.email_set_chunked(updates)?;
    if bad > 0 {
        tracing::warn!("routing: {bad} of {n} re-files rejected");
    }
    tracing::info!(
        "routing: re-filed {ok} message(s), {unmatched} left untouched (no rule matched)"
    );
    Ok(ok)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::Rules;

    fn rules_with(routing: &str) -> Rules {
        serde_json::from_str(&format!(
            r#"{{"account":"a@b.c","folders":{{}},"filters":{{}},"routing":{routing}}}"#
        ))
        .expect("rules parse")
    }

    fn email(from: &str) -> jmap::Email {
        serde_json::from_value(serde_json::json!({
            "id": "e1",
            "mailboxIds": {"inbox": true},
            "from": [{"email": from}],
        }))
        .expect("email parse")
    }

    // Order is priority: junk-ish catch-all listed AFTER the curated rule must
    // not win. This is the exact bug that left `24 House` holding 1 of 370.
    #[test]
    fn first_match_wins_in_list_order() {
        let r = rules_with(
            r#"[{"folder":"24 House","match":{"type":"from_domain","values":["wg-gesucht.de"]}},
                {"folder":"93 Junk","match":{"type":"from_domain","values":["wg-gesucht.de"]}}]"#,
        );
        let ids: HashMap<&str, &str> =
            [("24 House", "id24"), ("93 Junk", "id93")].into_iter().collect();
        assert_eq!(
            pick_folder(&r, &ids, &email("noreply@wg-gesucht.de"), true, 0.0),
            Some("id24")
        );
    }

    // The invariant that keeps a backfill from being destructive: a message no
    // rule claims must yield None so the caller skips it untouched.
    #[test]
    fn unmatched_yields_none() {
        let r = rules_with(
            r#"[{"folder":"24 House","match":{"type":"from_domain","values":["wg-gesucht.de"]}}]"#,
        );
        let ids: HashMap<&str, &str> = [("24 House", "id24")].into_iter().collect();
        assert_eq!(pick_folder(&r, &ids, &email("bill@example.com"), true, 0.0), None);
    }

    // Out of the source scope means out of scope, matching rule or not.
    #[test]
    fn outside_source_scope_is_never_routed() {
        let r = rules_with(
            r#"[{"folder":"24 House","match":{"type":"from_domain","values":["wg-gesucht.de"]}}]"#,
        );
        let ids: HashMap<&str, &str> = [("24 House", "id24")].into_iter().collect();
        assert_eq!(
            pick_folder(&r, &ids, &email("noreply@wg-gesucht.de"), false, 0.0),
            None
        );
    }
}
