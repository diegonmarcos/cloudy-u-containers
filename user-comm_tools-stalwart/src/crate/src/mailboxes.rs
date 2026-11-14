//! Mailbox reconciliation: renames, ensure-exists, and stale cleanup.

use anyhow::Result;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};

use crate::jmap::{Client, Mailbox, PAGE};
use crate::rules::{FolderOptions, Rules};

/// Mailbox names the server owns; never reaped, never renamed.
const SYSTEM_FOLDERS: &[&str] = &[
    "INBOX", "Sent", "Drafts", "Trash", "Junk", "Archive",
    "Sent Items", "Deleted Items", "Junk Mail", "Outbox", "Templates",
];

pub fn find_inbox_id(mailboxes: &[Mailbox]) -> Option<&str> {
    mailboxes
        .iter()
        .find(|mb| mb.role.as_deref() == Some("inbox") || mb.name == "INBOX")
        .map(|mb| mb.id.as_str())
}

/// Plans a single `Mailbox/set` batch: which mailboxes to create, which
/// misparented ones to move.
struct Planner<'a> {
    by_name: HashMap<&'a str, Vec<&'a Mailbox>>,
    creates: Map<String, Value>,
    updates: Map<String, Value>,
    counter: usize,
    /// Per-folder client-visibility options, consulted by name at create time
    /// and by the subscription reconcile below.
    opts: &'a FolderOptions,
}

impl<'a> Planner<'a> {
    fn new(existing: &'a [Mailbox], opts: &'a FolderOptions) -> Self {
        let mut by_name: HashMap<&str, Vec<&Mailbox>> = HashMap::new();
        for mb in existing {
            by_name.entry(mb.name.as_str()).or_default().push(mb);
        }
        Self { by_name, creates: Map::new(), updates: Map::new(), counter: 0, opts }
    }

    /// Mailbox id for `(name, parent)`. Moves a straggler rather than creating
    /// a duplicate; queues a create (returning a `#ref`) when truly missing.
    fn pick_or_create(
        &mut self,
        name: &str,
        parent: Option<&str>,
        ref_prefix: &str,
        sort_order: u32,
    ) -> String {
        let id = {
            let candidates = self.by_name.get(name).map(Vec::as_slice).unwrap_or(&[]);
            // Prefer one already at the expected parent.
            let exact = candidates
                .iter()
                .find(|c| c.parent_id.as_deref() == parent)
                .map(|c| c.id.clone());
            match exact {
                Some(id) => Some((id, false)),
                // Otherwise reparent the first candidate (cheap fix for the
                // legacy-parent-with-valid-child layout). Never create a
                // duplicate — duplicates are what block the legacy parent from
                // ever being destroyed (`mailboxHasChild`).
                None => candidates.first().map(|stray| (stray.id.clone(), true)),
            }
        };

        self.counter += 1;
        match id {
            Some((id, false)) => id,
            Some((id, true)) => {
                self.updates.insert(id.clone(), json!({ "parentId": parent }));
                id
            }
            None => {
                // Truly missing — queue a create and hand back the JMAP
                // back-reference so children can be parented in the same batch.
                let r = format!("{ref_prefix}_{}", self.counter - 1);
                self.creates.insert(
                    r.clone(),
                    json!({
                        "name": name,
                        "parentId": parent,
                        "sortOrder": sort_order,
                        // Create SUBSCRIBED (unless the rules say otherwise):
                        // Stalwart's default is unsubscribed, which hides the
                        // folder from every client that lists only subscribed
                        // mailboxes. See FolderOptions.
                        "isSubscribed": self.opts.subscribed_for(name),
                    }),
                );
                format!("#{r}")
            }
        }
    }
}

/// How many `folder_parents` hops `name` is from the root.
///
/// Walks with a visit set: a malformed map that cycles must terminate here
/// rather than spin the reconcile loop forever.
fn parent_depth(parents: &BTreeMap<String, String>, name: &str) -> usize {
    let mut seen: HashSet<&str> = HashSet::new();
    let mut cur = name;
    let mut d = 0;
    while let Some(parent) = parents.get(cur) {
        if !seen.insert(cur) {
            tracing::warn!("folder_parents cycle at {cur:?}; treating as ROOT");
            return d;
        }
        cur = parent.as_str();
        d += 1;
    }
    d
}

/// Reconcile mailbox state with the rules.
///
/// Two steps: plan every `(name, parent)` the rules declare (preferring an
/// existing correctly-parented mailbox, else reparenting a straggler, else
/// queueing a create), then apply them in one `Mailbox/set`.
///
/// Returns `(name -> id, full mailbox list)`, both re-fetched after the set
/// call because `pick_or_create` hands back unresolved `#ref` placeholders.
pub fn ensure_mailboxes(
    client: &Client,
    rules: &Rules,
) -> Result<(HashMap<String, String>, Vec<Mailbox>)> {
    let existing = client.mailbox_get()?;
    let mut plan = Planner::new(&existing, &rules.folder_options);

    // Every managed mailbox as (name, sortOrder), in the order that decides
    // sortOrder for newly created ones. Parentage comes from
    // `rules.folder_parents` alone — see below.
    let folders_len = rules.folders.len() as u32;
    let mut declared: Vec<(&str, u32)> = Vec::new();
    for (i, folder) in rules.folders.values().enumerate() {
        declared.push((folder.as_str(), i as u32 + 1));
    }
    for (gi, group) in rules.folder_groups.iter().enumerate() {
        declared.push((group.name.as_str(), folders_len + 1 + gi as u32));
        for (ci, child) in group.children.values().enumerate() {
            declared.push((child.as_str(), ci as u32));
        }
    }
    for (j, label) in rules.folders_ui.iter().enumerate() {
        declared.push((label.as_str(), 100 + j as u32));
    }
    for (j, label) in rules.root_folders.iter().enumerate() {
        declared.push((label.as_str(), 150 + j as u32));
    }
    // Filter views: section headers plus one folder per view. Membership is
    // maintained by `maintain_filters`; here we only ensure they exist.
    for (k, label) in rules.filters.section_headers.iter().enumerate() {
        declared.push((label.as_str(), 200 + k as u32));
    }
    for (vi, view) in rules.filters.views.iter().enumerate() {
        declared.push((view.folder.as_str(), 300 + vi as u32));
    }

    // Plan shallowest-first, so a parent always has an id (real, or a `#ref`
    // resolvable inside this same Mailbox/set) before any child asks for it.
    //
    // `sort_by_key` is STABLE, so folders at equal depth keep the declaration
    // order above and therefore their sortOrder.
    declared.sort_by_key(|(name, _)| parent_depth(&rules.folder_parents, name));

    // name -> planned id, so a child can name its parent. Holds `#ref`
    // placeholders for mailboxes created in this batch; JMAP resolves those
    // back-references server-side within the one Mailbox/set.
    let mut planned: HashMap<&str, String> = HashMap::new();
    for (name, sort_order) in declared {
        let parent: Option<String> = rules
            .folder_parents
            .get(name)
            .and_then(|p| planned.get(p.as_str()).cloned());
        // A declared parent we could not resolve means the parent is missing
        // from the declaration set entirely. Leaving the child at ROOT would
        // silently flatten it, so say so — the tree is the contract.
        if parent.is_none() {
            if let Some(p) = rules.folder_parents.get(name) {
                tracing::warn!("parent {p:?} of {name:?} is not a declared folder; leaving at ROOT");
            }
        }
        let id = plan.pick_or_create(name, parent.as_deref(), "mbox", sort_order);
        planned.insert(name, id);
    }

    if !plan.creates.is_empty() || !plan.updates.is_empty() {
        if !plan.creates.is_empty() {
            tracing::info!("Creating {} mailboxes...", plan.creates.len());
        }
        if !plan.updates.is_empty() {
            tracing::info!("Reparenting {} misparented mailboxes...", plan.updates.len());
        }
        let result = client.mailbox_set(Some(plan.creates), Some(plan.updates), None, false)?;
        for (r, err) in &result.not_created {
            tracing::warn!("Failed to create {r}: {err}");
        }
        for (mid, err) in &result.not_updated {
            tracing::warn!("Failed to reparent {mid}: {err}");
        }
    }

    // Always re-fetch — `pick_or_create` returned create-refs (`#ref_N`) for
    // missing mailboxes; those resolve to real ids only via a fresh
    // Mailbox/get.
    let existing = client.mailbox_get()?;

    // Reconcile subscription on folders that ALREADY existed. Setting
    // isSubscribed at create time only helps mailboxes created from now on;
    // every folder made before this shipped is still unsubscribed and
    // therefore invisible in clients that list only subscribed mailboxes
    // (measured on oci-mail: 53 of 60). Idempotent — once each folder matches
    // its declared value this builds an empty patch and issues no call.
    //
    // Scope is deliberately narrow: only names the rules actually manage.
    // The server's own system folders (INBOX/Sent/Drafts/...) are left
    // exactly as the server set them.
    let managed = valid_names(rules);
    let mut sub_updates: Map<String, Value> = Map::new();
    for mb in &existing {
        if !managed.contains(&mb.name) || SYSTEM_FOLDERS.contains(&mb.name.as_str()) {
            continue;
        }
        let want = rules.folder_options.subscribed_for(&mb.name);
        if mb.is_subscribed != want {
            sub_updates.insert(mb.id.clone(), json!({ "isSubscribed": want }));
        }
    }
    if !sub_updates.is_empty() {
        tracing::info!("Updating subscription on {} mailboxes...", sub_updates.len());
        let res = client.mailbox_set(None, Some(sub_updates), None, false)?;
        for (mid, err) in &res.not_updated {
            tracing::warn!("Failed to set isSubscribed on {mid}: {err}");
        }
    }

    let name_to_id = existing
        .iter()
        .map(|mb| (mb.name.clone(), mb.id.clone()))
        .collect();
    Ok((name_to_id, existing))
}

/// Reconcile mailbox names (`old -> new`) from `rules.folder_renames.map`.
///
/// Three cases, all idempotent:
///   1. old absent              -> nothing to do.
///   2. old present, new absent -> in-place `Mailbox/set` name update. JMAP
///      preserves the mailbox's emails and children, which is the whole point
///      versus create-new + reap-old.
///   3. old present, new present -> MERGE: move every email from old into new,
///      then destroy old.
///
/// Case 3 used to be a silent no-op ("rename only when new does not exist").
/// That stranded mail: once the new folder had been created by any other path
/// the rename never fired, and the old folder kept accumulating messages that
/// were invisible to every rule keyed on the new name. Observed in production
/// as 230 messages marooned in `Aa 📬 Others (fallback)` while
/// `91 📬 Others (fallback)` was the live target.
pub fn apply_renames(client: &Client, rules: &Rules, mailboxes: &[Mailbox]) -> Result<()> {
    let renames = &rules.folder_renames.map;
    if renames.is_empty() {
        return Ok(());
    }
    let by_name: HashMap<&str, &str> = mailboxes
        .iter()
        .map(|mb| (mb.name.as_str(), mb.id.as_str()))
        .collect();

    let mut updates: Map<String, Value> = Map::new();
    let mut merges: Vec<(&str, &str, &str, &str)> = Vec::new();

    for (old_name, new_name) in renames {
        let Some(old_id) = by_name.get(old_name.as_str()).copied() else {
            continue;
        };
        match by_name.get(new_name.as_str()).copied() {
            None => {
                updates.insert(old_id.to_string(), json!({ "name": new_name }));
            }
            Some(new_id) if new_id != old_id => {
                merges.push((old_name.as_str(), old_id, new_name.as_str(), new_id));
            }
            Some(_) => {}
        }
    }

    if !updates.is_empty() {
        tracing::info!("Renaming {} mailbox(es) in place (keep emails)...", updates.len());
        let result = client.mailbox_set(None, Some(updates), None, false)?;
        for (mid, err) in &result.not_updated {
            tracing::warn!("Rename failed {mid}: {err}");
        }
    }

    for (old_name, old_id, new_name, new_id) in merges {
        let ids = client.email_query_in(&[old_id.to_string()], None)?;
        tracing::info!("Merging {old_name:?} -> {new_name:?} ({} message(s))", ids.len());
        for chunk in ids.chunks(PAGE) {
            let emails = client.email_get(chunk, &["mailboxIds"])?;
            let mut patch: Map<String, Value> = Map::new();
            for em in &emails {
                patch.insert(
                    em.id.clone(),
                    Value::Object(crate::inbox_guard::membership_patch(&[new_id], &[old_id])),
                );
            }
            let res = client.email_set(patch)?;
            for (eid, err) in &res.not_updated {
                tracing::warn!("Merge move failed {eid}: {err}");
            }
        }
        // Only reap once empty; onDestroyRemoveEmails would delete stragglers
        // outright, and losing mail is exactly the failure we are fixing.
        let left = client.email_query_in(&[old_id.to_string()], None)?;
        if !left.is_empty() {
            tracing::warn!("Not destroying {old_name:?}: {} message(s) still present", left.len());
            continue;
        }
        let res = client.mailbox_set(None, None, Some(vec![old_id.to_string()]), false)?;
        for (mid, err) in &res.not_destroyed {
            tracing::warn!("Destroy failed {mid}: {err}");
        }
    }
    Ok(())
}

/// Every mailbox name the rules currently declare, plus the server's own.
fn valid_names(rules: &Rules) -> HashSet<String> {
    let mut valid: HashSet<String> = HashSet::new();
    valid.extend(rules.folders.values().cloned());
    for group in &rules.folder_groups {
        valid.insert(group.name.clone());
        valid.extend(group.children.values().cloned());
    }
    valid.extend(rules.folders_ui.iter().cloned());
    valid.extend(rules.root_folders.iter().cloned());
    valid.extend(rules.filters.section_headers.iter().cloned());
    valid.extend(rules.filters.views.iter().map(|v| v.folder.clone()));
    valid.extend(SYSTEM_FOLDERS.iter().map(|s| s.to_string()));
    valid
}

/// Delete folders the rules no longer declare, plus duplicates of ones they do.
pub fn cleanup_stale(
    client: &Client,
    rules: &Rules,
    name_to_id: &HashMap<String, String>,
    mailboxes: &[Mailbox],
) -> Result<()> {
    let valid = valid_names(rules);

    // Pass 1: names that aren't current valid ones (true orphans).
    let mut stale: Vec<&Mailbox> = mailboxes
        .iter()
        .filter(|mb| !valid.contains(&mb.name) && mb.role.is_none())
        .collect();

    // Pass 2: valid-name DUPLICATES. `name_to_id` is keyed by name and holds
    // the *canonical* id (the one at the expected parent). Any other mailbox
    // sharing that name is a duplicate — e.g. the post-rename leftover sitting
    // under a legacy parent, which keeps that legacy parent un-destroyable via
    // `mailboxHasChild`. Reaping them here unblocks the parent next poll.
    stale.extend(mailboxes.iter().filter(|mb| {
        valid.contains(&mb.name)
            && mb.role.is_none()
            && name_to_id.get(&mb.name).map(String::as_str) != Some(mb.id.as_str())
    }));

    if stale.is_empty() {
        return Ok(());
    }
    tracing::info!("Found {} stale folders to clean", stale.len());

    // Move emails from stale folders to INBOX first, then delete.
    let inbox_id = find_inbox_id(mailboxes).map(str::to_string);
    for mb in &stale {
        let Some(inbox_id) = &inbox_id else { break };
        let moved = (|| -> Result<()> {
            let eids = client.email_query_in(&[mb.id.clone()], Some(PAGE))?;
            if eids.is_empty() {
                return Ok(());
            }
            let emails = client.email_get(&eids, &["mailboxIds"])?;
            let mut updates: Map<String, Value> = Map::new();
            for em in &emails {
                updates.insert(
                    em.id.clone(),
                    Value::Object(crate::inbox_guard::membership_patch(&[inbox_id.as_str()], &[mb.id.as_str()])),
                );
            }
            client.email_set(updates)?;
            Ok(())
        })();
        if let Err(e) = moved {
            tracing::warn!("Error moving emails from {}: {e}", mb.name);
        }
    }

    // Depth from the FULL mailbox list so we delete deepest-first. A stale
    // parent that still has non-stale children won't destroy until those are
    // reparented to ROOT — `ensure_mailboxes` does that in the same poll, so
    // this just needs to retry across polls until the children move.
    let mut by_parent: HashMap<Option<&str>, Vec<&str>> = HashMap::new();
    for mb in mailboxes {
        by_parent.entry(mb.parent_id.as_deref()).or_default().push(&mb.id);
    }
    fn depth<'a>(
        id: &'a str,
        by_parent: &HashMap<Option<&'a str>, Vec<&'a str>>,
        seen: &mut HashSet<&'a str>,
    ) -> usize {
        if !seen.insert(id) {
            return 0;
        }
        let kids = by_parent.get(&Some(id)).map(Vec::as_slice).unwrap_or(&[]);
        1 + kids.iter().map(|k| depth(k, by_parent, seen)).max().unwrap_or(0)
    }

    let mut ordered: Vec<(&Mailbox, usize)> = stale
        .iter()
        .map(|mb| (*mb, depth(&mb.id, &by_parent, &mut HashSet::new())))
        .collect();
    ordered.sort_by_key(|(_, d)| std::cmp::Reverse(*d));

    for (mb, _) in ordered {
        // Polite destroy only (onDestroyRemoveEmails stays false). If a child
        // relationship is the blocker we surface it and let the next poll
        // pick it up after `ensure_mailboxes` reparents.
        let result = match client.mailbox_set(None, None, Some(vec![mb.id.clone()]), false) {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("Destroy call failed for {}: {e}", mb.name);
                continue;
            }
        };
        if result.destroyed.iter().any(|d| d == &mb.id) {
            tracing::info!("Deleted stale: {}", mb.name);
            continue;
        }
        let Some(err) = result.not_destroyed.get(&mb.id) else {
            // No success entry AND no failure entry — surface the oddly-shaped
            // response rather than silently dropping it (the prior bug).
            tracing::warn!("Destroy returned no status for {}: {:?}", mb.name, result);
            continue;
        };
        let reason = err.get("type").and_then(Value::as_str).unwrap_or("").to_string();
        if reason == "mailboxHasEmail" || reason == "tooManyEmails" {
            // NEVER onDestroyRemoveEmails=true: a message that is in no other
            // mailbox would be destroyed with the folder. The mail was already
            // given Inbox above (membership patch); if a straggler arrived
            // since, the next poll moves it and the destroy then succeeds.
            tracing::warn!("Not destroying {} yet: {reason}; mail is moved to Inbox first, retry next poll", mb.name);
        } else {
            // `mailboxHasChild` / unknown — leave for next poll once
            // ensure_mailboxes has reparented the valid children to ROOT.
            let shown = if reason.is_empty() { err.to_string() } else { reason };
            tracing::info!("Skipping {} for now: {shown} (will retry next poll)", mb.name);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parents(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs.iter().map(|(c, p)| (c.to_string(), p.to_string())).collect()
    }

    /// The live shape: `30 _ CLOUD` -> `31 …` -> `GH Workflows` is three deep,
    /// which is the whole reason the two-level `folder_groups` special case was
    /// not enough.
    #[test]
    fn depth_counts_hops_to_root() {
        let p = parents(&[
            ("11    Admin", "10 _ ADMIN"),
            ("31    Cloud", "30 _ CLOUD"),
            ("GH Workflows", "31    Cloud"),
        ]);
        assert_eq!(parent_depth(&p, "10 _ ADMIN"), 0);
        assert_eq!(parent_depth(&p, "11    Admin"), 1);
        assert_eq!(parent_depth(&p, "31    Cloud"), 1);
        assert_eq!(parent_depth(&p, "GH Workflows"), 2);
    }

    /// A folder with no declared parent is ROOT, not an error. `01 Inbox -
    /// noAlerts` has no `00` header and must stay where it is.
    #[test]
    fn unparented_folder_is_root() {
        let p = parents(&[("11    Admin", "10 _ ADMIN")]);
        assert_eq!(parent_depth(&p, "01_No-Alerts"), 0);
    }

    /// A cycle must terminate. Before the visit set this spun forever, and the
    /// reconcile loop with it.
    #[test]
    fn cyclic_parents_terminate() {
        let p = parents(&[("a", "b"), ("b", "a")]);
        assert!(parent_depth(&p, "a") <= 2);
    }

    /// The ordering contract `ensure_mailboxes` relies on: after the stable
    /// depth sort, every parent is planned before any of its children, so
    /// `planned` always has the parent's id ready.
    #[test]
    fn depth_sort_puts_every_parent_before_its_children() {
        let p = parents(&[
            ("GH Workflows", "31    Cloud"),
            ("31    Cloud", "30 _ CLOUD"),
            ("11    Admin", "10 _ ADMIN"),
        ]);
        // Deliberately worst-case: deepest first, parents last.
        let mut declared = vec![
            ("GH Workflows", 0u32),
            ("11    Admin", 1),
            ("31    Cloud", 2),
            ("30 _ CLOUD", 3),
            ("10 _ ADMIN", 4),
        ];
        declared.sort_by_key(|(name, _)| parent_depth(&p, name));

        let mut seen: HashSet<&str> = HashSet::new();
        for (name, _) in &declared {
            if let Some(parent) = p.get(*name) {
                assert!(
                    seen.contains(parent.as_str()),
                    "{name:?} planned before its parent {parent:?}"
                );
            }
            seen.insert(name);
        }
    }

    /// Equal-depth folders keep declaration order, which is what hands each
    /// newly created mailbox a stable `sortOrder` across restarts.
    #[test]
    fn depth_sort_is_stable_within_a_level() {
        let p = parents(&[("11    Admin", "10 _ ADMIN"), ("12    Finance", "10 _ ADMIN")]);
        let mut declared = vec![("11    Admin", 1u32), ("12    Finance", 2), ("10 _ ADMIN", 100)];
        declared.sort_by_key(|(name, _)| parent_depth(&p, name));
        assert_eq!(
            declared,
            vec![("10 _ ADMIN", 100u32), ("11    Admin", 1), ("12    Finance", 2)]
        );
    }
}
