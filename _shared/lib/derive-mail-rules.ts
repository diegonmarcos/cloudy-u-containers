// derive-mail-rules.ts
//
// Canonical mail rules -> the three engine artifacts, as FILES.
//
// Replaces _shared/lib/mail-rules.nix. The flakes no longer compute anything:
// they mount what this writes. Nix is orchestration (which files go where in
// the image), this is the compiler (what those files contain). Inlining the
// compiler into the flake meant the only way to see a generated artifact was
// to evaluate Nix, and the only way to test one was a golden capture through
// nix-instantiate.
//
//   mail-rules-general.json  ─┐
//   mail-rules-profile-*.json ┴─> derive-mail-rules.ts
//        ├─> user-comm_tools-stalwart/src/templates/default.sieve.tpl
//        ├─> user-comm_tools-stalwart/dist/assets/mail-rules.json   (legacy schema)
//        └─> user-comm_tools-maddy/dist/assets/mail-rules.json      (maddy subset)
//
// Byte-compatible with the Nix it replaces, which is the whole point of the
// migration being verifiable: `--check` diffs every emitter against the
// committed artifacts and the golden files rather than trusting the port.
//
// Nix compatibility notes that are NOT incidental:
//   * builtins.toJSON sorts attrset keys, because Nix attrsets ARE sorted.
//     JSON.stringify preserves insertion order, so every object is emitted
//     through stableStringify or the output differs from the committed asset
//     on key order alone.
//   * The legacy asset is compact with NO trailing newline (`wc -l` = 0).
//   * lib.unique keeps FIRST occurrence order, unlike a naive Set round-trip
//     on a sorted list.
//
// Usage:
//   tsx derive-mail-rules.ts            # write artifacts
//   tsx derive-mail-rules.ts --check    # verify, write nothing, exit 1 on drift
//   tsx derive-mail-rules.ts --emit DIR # golden capture for run-tests.sh

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ── Types ───────────────────────────────────────────────────────────

type Json = any;

interface Merged {
  schema_version: number;
  account: string;
  sieve_require: string[];
  folders: Record<string, string>;
  folder_groups: Json[];
  folders_ui: string[];
  root_folders: string[];
  routing_default: string;
  inbox_copy: { enabled?: boolean; flags?: string[] };
  cleanup: Json;
  filters: { views?: Json[]; section_headers?: Json[]; [k: string]: Json };
  folder_renames: Json;
  folder_options: Json;
  predicates: Record<string, Json>;
  rules: Json[];
}

// ── Nix-compatible helpers ──────────────────────────────────────────

/** lib.unique: keep first occurrence, preserve order. */
function unique<T>(xs: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of xs) {
    const k = JSON.stringify(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

/**
 * builtins.toJSON: compact, and object keys in lexicographic order because a
 * Nix attrset is a sorted map. Arrays keep their order.
 */
function stableStringify(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

/** jq's default rendering, for the maddy golden (2-space, sorted keys). */
function prettyStringify(value: Json, indent = 0): string {
  const pad = ' '.repeat(indent);
  const pad2 = ' '.repeat(indent + 2);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return '[\n' + value.map((v) => pad2 + prettyStringify(v, indent + 2)).join(',\n') + '\n' + pad + ']';
  }
  const keys = Object.keys(value).sort();
  if (keys.length === 0) return '{}';
  return (
    '{\n' +
    keys.map((k) => pad2 + JSON.stringify(k) + ': ' + prettyStringify(value[k], indent + 2)).join(',\n') +
    '\n' + pad + '}'
  );
}

// ── Loading & merging ───────────────────────────────────────────────

function loadJson(p: string): Json {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function merge(general: Json, profile: Json | null): Merged {
  const p = profile ?? {};
  return {
    schema_version: general.schema_version ?? 2,
    account: p.account ?? general.account ?? '',
    sieve_require: unique([...(general.sieve_require ?? []), ...(p.sieve_require ?? [])]),
    folders: { ...(general.folders ?? {}), ...(p.folders_extend ?? {}), ...(p.folders ?? {}) },
    // Concat, not merge-by-key: a profile can add a whole extra group, but
    // there is no per-group override story yet.
    folder_groups: [...(general.folder_groups ?? []), ...(p.folder_groups ?? [])],
    folders_ui: unique([...(general.folders_ui ?? []), ...(p.folders_ui ?? [])]),
    root_folders: unique([...(general.root_folders ?? []), ...(p.root_folders ?? [])]),
    routing_default: p.routing_default ?? general.routing_default ?? 'others',
    inbox_copy: p.inbox_copy ?? general.inbox_copy ?? { enabled: false, flags: [] },
    cleanup: p.cleanup ?? general.cleanup ?? {},
    // Views resolve `ref` exactly like rules do. Without this a `{"ref": ...}`
    // inside a view predicate reached the artifacts verbatim, where the Rust's
    // tagged Predicate enum has no such variant -- a startup error, and until
    // then the only way to share one predicate between two views was to paste
    // it twice (Ea's flag list and Eb's negation of it were exactly that, and
    // the Eb _doc claimed they were "referencing the same tree" while being a
    // second copy that nothing kept in sync).
    // Pattern-declared axes (G0 _ AUTH) are expanded HERE into a section
    // header + views, so every consumer -- the Stalwart jmap-sorter's JMAP
    // folders and filter views, folderParents' tree, and the Maddy subset --
    // reads them from the one `filters` tree like any A0-F0 axis.
    filters: expandPatternAxes(resolveViews(
      { ...(general.predicates ?? {}), ...(p.predicates ?? {}) },
      p.filters ?? general.filters ?? { views: [], section_headers: [] },
    )),
    folder_renames: p.folder_renames ?? general.folder_renames ?? { map: {} },
    folder_options: p.folder_options ?? general.folder_options ?? {},
    predicates: { ...(general.predicates ?? {}), ...(p.predicates ?? {}) },
    rules: [...(general.rules ?? []), ...(p.rules ?? [])],
  };
}

export function loadAndMerge(generalPath: string, profilePath: string | null): Merged {
  return merge(loadJson(generalPath), profilePath ? loadJson(profilePath) : null);
}

// ── Predicate resolution ────────────────────────────────────────────

/** Every view's predicate, with `ref`s resolved. See the call in [[merge]]. */
export function resolveViews(predicates: Record<string, Json>, filters: Json): Json {
  return {
    ...filters,
    views: (filters.views ?? []).map((v: Json) => ({
      ...v,
      predicate: resolvePredicate(predicates, v.predicate),
    })),
  };
}

export function resolvePredicate(predicates: Record<string, Json>, pred: Json): Json {
  if (pred && typeof pred === 'object') {
    if ('ref' in pred) return resolvePredicate(predicates, predicates[pred.ref]);
    if ('any_of' in pred) return { any_of: pred.any_of.map((c: Json) => resolvePredicate(predicates, c)) };
    if ('all_of' in pred) return { all_of: pred.all_of.map((c: Json) => resolvePredicate(predicates, c)) };
    if ('not' in pred) return { not: resolvePredicate(predicates, pred.not) };
  }
  return pred;
}

// ── Pattern-declared axes (G0 _ AUTH) ───────────────────────────────

/**
 * Both engines an axis must reach. An axis the Maddy sorter files on the
 * server but the Stalwart jmap-sorter never sees has no JMAP folders and no
 * JMAP filter view -- invisible to every JMAP client (Cloud Mail, webmail) and
 * never applied to new mail there. That is exactly how G0 _ AUTH first
 * shipped (declared `engines: ["maddy"]`), so a declaration that leaves an
 * engine out is now a build error, not a choice.
 */
export const PATTERN_AXIS_ENGINES = ['maddy', 'stalwart'];

/**
 * The G0 _ AUTH axis (Ga Code / Gb Link to auth / Gc No Auth) as filter VIEWS,
 * DERIVED from the declared pattern set (`_shared/mail-auth-patterns.json`) --
 * never restated. Both servers see headers only here, so both classes are
 * decided on the Subject. Exclusive and exhaustive by construction: Gb is "a
 * link phrase and not a code", Gc is "neither" -- the views are additive (no
 * first-match ordering in the Stalwart engine), so the exclusion is in each
 * predicate rather than in rule order.
 */
export function authAxisViews(pat: Json): Json[] {
  const code = { type: 'header_contains', header: 'Subject', values: pat.code_subject_phrases };
  const link = { type: 'header_contains', header: 'Subject', values: pat.link_phrases };
  const c = pat.classes;
  const view = (folder: string, predicate: Json, doc: string) =>
    ({ folder, axis: 'auth', volatile: false, _doc: doc, predicate });
  return [
    view(c.Ga.folder, code, `${c.Ga.name}: Subject carries a one-time-code phrase. Derived from _shared/mail-auth-patterns.json -- do not hand-edit.`),
    view(c.Gb.folder, { all_of: [link, { not: code }] }, `${c.Gb.name}: Subject carries a sign-in / verification link phrase and no code phrase. Derived from _shared/mail-auth-patterns.json -- do not hand-edit.`),
    view(c.Gc.folder, { not: { any_of: [code, link] } }, `${c.Gc.name}: neither. Derived from _shared/mail-auth-patterns.json -- do not hand-edit.`),
  ];
}

const PATTERN_AXIS_BUILDERS: Record<string, (pat: Json) => Json[]> = { auth: authAxisViews };

/**
 * Expand every `filters.axes_from_patterns` declaration into its section
 * header (appended to `section_headers`) and its views (appended to `views`).
 * Throws on a declaration that would reach one engine only, or on an axis kind
 * with no builder.
 */
export function expandPatternAxes(filters: Json): Json {
  const axes = (filters.axes_from_patterns ?? []) as Json[];
  if (axes.length === 0) return filters;
  const headers = [...(filters.section_headers ?? [])];
  const views = [...(filters.views ?? [])];
  for (const a of axes) {
    const missing = PATTERN_AXIS_ENGINES.filter((e) => !(a.engines ?? []).includes(e));
    if (missing.length)
      throw new Error(`axis ${a.header ?? a.axis}: engines must include ${missing.join(', ')} -- an axis on the server needs its JMAP folders and filter views too`);
    const build = PATTERN_AXIS_BUILDERS[a.axis];
    if (!build) throw new Error(`axis ${a.axis}: no view builder in derive-mail-rules.ts`);
    if (!a.header || !a.patterns) throw new Error(`axis ${a.axis}: needs a header and a patterns file`);
    const pat = JSON.parse(fs.readFileSync(path.join(ROOT, a.patterns), 'utf8'));
    if (!headers.includes(a.header)) headers.push(a.header);
    for (const v of build(pat)) {
      if (v.folder[0] !== a.header[0])
        throw new Error(`axis ${a.header}: view ${v.folder} does not carry the header's class letter`);
      views.push(v);
    }
  }
  return { ...filters, section_headers: headers, views };
}

// ── Sieve compilation ───────────────────────────────────────────────

/** one -> "x"   many -> ["x", "y"] */
function sieveList(vs: string[]): string {
  if (vs.length === 1) return `"${vs[0]}"`;
  return '[' + vs.map((v) => `"${v}"`).join(', ') + ']';
}

export function sieveAtom(account: string, p: Json): string {
  const t = p.type;
  switch (t) {
    case 'from_domain': return `address :domain :is "From" ${sieveList(p.values)}`;
    case 'from_domain_suffix': return `address :domain :matches "From" ${sieveList(p.values.map((v: string) => '*' + v))}`;
    case 'from_address': return `address :is "From" ${sieveList(p.values)}`;
    case 'to_contains': return `address :contains "To" ${sieveList(p.values)}`;
    case 'reply_to_contains': return `address :contains "Reply-To" ${sieveList(p.values)}`;
    case 'header_contains': return `header :contains "${p.header}" ${sieveList(p.values)}`;
    case 'header_regex': return `header :regex "${p.header}" "${p.regex}"`;
    case 'header_exists': return `exists "${p.header}"`;
    case 'subject_contains': return `header :contains "Subject" ${sieveList(p.values)}`;
    case 'list_id_contains': return `header :contains "List-Id" ${sieveList(p.values)}`;
    case 'body_contains': return `body :text :contains ${sieveList(p.values)}`;
    case 'size_over': return `size :over ${p.bytes}`;
    case 'size_under': return `size :under ${p.bytes}`;
    case 'content_type': {
      // :anychild takes a single value per call; anyof many calls when needed.
      const mk = (ct: string) => `header :mime :anychild :contenttype "Content-Type" "${ct}"`;
      if (p.values.length === 1) return mk(p.values[0]);
      return `anyof(${p.values.map(mk).join(', ')})`;
    }
    case 'has_cc': return `exists "Cc"`;
    case 'has_bcc': return `exists "Bcc"`;
    case 'list_header': return `exists ["List-Id", "List-Unsubscribe"]`;
    case 'self_sent': return `address :is "From" "${account}"`;
    case 'spf_pass': return `header :contains "Received-SPF" "pass"`;
    case 'dkim_pass': return `header :contains "Authentication-Results" "dkim=pass"`;
    default: return `false /* unsupported: ${t} */`;
  }
}

export function sieveTest(account: string, p: Json): string {
  if (p && typeof p === 'object') {
    if ('any_of' in p) return `anyof(${p.any_of.map((c: Json) => sieveTest(account, c)).join(', ')})`;
    if ('all_of' in p) return `allof(${p.all_of.map((c: Json) => sieveTest(account, c)).join(', ')})`;
    if ('not' in p) return `not ${sieveTest(account, p.not)}`;
  }
  return sieveAtom(account, p);
}

/** Stable sort by priority (default 500); original index is the tiebreak. */
export function sortByPriority(rules: Json[]): Json[] {
  return rules
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const pa = a.r.priority ?? 500;
      const pb = b.r.priority ?? 500;
      return pa === pb ? a.i - b.i : pa - pb;
    })
    .map((x) => x.r);
}

/**
 * The folder TREE, as an explicit `child display name -> parent display name`
 * map. The ONE place the hierarchy is derived; every consumer reads this.
 *
 * The rule is the owner's own, and it already lived in the repo twice --
 * `src/flake.nix::findParent` (which lowers it into activate.sh's `name|parent`
 * table) and, implicitly, in `folder_groups`: the FIRST CHARACTER of a folder's
 * prefix selects its parent, which is the declared section header of that same
 * class. `11 Admin` and `12 Finance` hang off `10 _ ADMIN`; `Aa/Ab/Ac` hang off
 * `A0 _ SIZE`.
 *
 * The section headers (`folders_ui` + `filters.section_headers`) were created
 * as flat ROOT siblings whose only job was to sort just above their block --
 * a simulated hierarchy. They are real parents now, so the sort trick and the
 * nesting agree instead of competing.
 *
 * `folder_groups` children keep their explicit group parent, which is how the
 * one already-nested branch (`31 Cloud - Reports & CI`) was built; feeding it
 * through the same map is what makes the CLOUD branch three deep
 * (`30 _ CLOUD / 31 Cloud - Reports & CI / GH Workflows`).
 *
 * A folder whose class has no declared `X0` header keeps `parentId: null` and
 * stays at ROOT -- `01_No-Alerts` is the live example. Unclassified
 * folders are left alone rather than forced somewhere they do not belong.
 */
export function folderParents(merged: Merged): Record<string, string> {
  const headers = [
    ...(merged.folders_ui ?? []),
    ...((merged.filters?.section_headers ?? []) as string[]),
  ];
  // class char -> header. First declaration wins; a second header claiming the
  // same class is a data error, not a silent overwrite.
  const byClass = new Map<string, string>();
  for (const h of headers) {
    const c = h[0];
    if (!c) continue;
    if (byClass.has(c) && byClass.get(c) !== h)
      throw new Error(`two section headers claim class "${c}": ${byClass.get(c)} and ${h}`);
    byClass.set(c, h);
  }

  const out: Record<string, string> = {};
  const attach = (name: string) => {
    const parent = byClass.get(name[0] ?? '');
    // No header for this class, or the folder IS the header: stays at ROOT.
    if (parent && parent !== name) out[name] = parent;
  };

  for (const name of Object.values(merged.folders ?? {})) attach(name);
  for (const g of merged.folder_groups ?? []) {
    attach(g.name);
    // Explicit group parent beats the prefix rule -- group children are named
    // without a prefix ("GH Workflows"), so the rule would not fire anyway.
    for (const child of Object.values(g.children ?? {}) as string[]) out[child] = g.name;
  }
  for (const v of (merged.filters?.views ?? []) as Json[]) attach(v.folder);

  return out;
}

/**
 * Full IMAP path of `name`, walking [folderParents] to the root.
 *
 * Sieve `fileinto` resolves a mailbox by its hierarchical PATH, so
 * `fileinto "GH Workflows"` does not find the child of "31 Cloud - Reports &
 * CI" -- it creates a NEW top-level mailbox of that name. That produced an
 * endless churn loop in production: Sieve created the root copy on delivery,
 * ensure_mailboxes reparented it under the group, cleanup_stale reaped it as a
 * duplicate, and the next message started over. 22 create/reparent/delete
 * events on oci-mail before it was caught.
 *
 * SIEVE side only. The Rust sorter addresses mailboxes by leaf name + parentId,
 * which is what JMAP Mailbox/set wants; it has no notion of a path.
 */
export function folderPath(parents: Record<string, string>, name: string): string {
  const segs = [name];
  const seen = new Set([name]);
  let cur = name;
  // Cycle guard: a malformed parent map must not hang the build.
  while (parents[cur]) {
    cur = parents[cur];
    if (seen.has(cur)) throw new Error(`folder parent cycle at ${cur}`);
    seen.add(cur);
    segs.unshift(cur);
  }
  return segs.join('/');
}

/**
 * Every Sieve-addressable routing target, keyed by rule slug, valued by FULL
 * IMAP PATH.
 */
function allFolderTargets(merged: Merged): Record<string, string> {
  const parents = folderParents(merged);
  const out: Record<string, string> = {};
  for (const [k, name] of Object.entries(merged.folders ?? {}))
    out[k] = folderPath(parents, name);
  for (const g of merged.folder_groups ?? [])
    for (const [k, child] of Object.entries(g.children ?? {}) as [string, string][])
      out[k] = folderPath(parents, child);
  return out;
}

/**
 * The same routing targets as [allFolderTargets], but keyed to the mailbox's
 * LEAF display name instead of its path.
 *
 * The two consumers want different things and always did. Sieve resolves by
 * path. The Rust sorter resolves by leaf name -- `routing.rs` looks each
 * `routing[].folder` up in `name_to_id`, which `ensure_mailboxes` builds as
 * `mailbox.name -> id`, and JMAP `name` is the leaf label with no hierarchy in
 * it. Handing it a path means every lookup misses, `routing_ids` comes back
 * empty, and the backfill logs "no target folder exists yet -- skipping" and
 * quietly re-routes nothing.
 *
 * That was already happening to the five `folder_groups` rules before the tree
 * was generalised, because those were the only targets `allFolderTargets`
 * returned a path for.
 */
function allFolderLeaves(merged: Merged): Record<string, string> {
  const out: Record<string, string> = { ...merged.folders };
  for (const g of merged.folder_groups ?? [])
    for (const [k, child] of Object.entries(g.children ?? {}) as [string, string][])
      out[k] = child;
  return out;
}

function effectiveFlags(rule: Json): string[] {
  const mode = rule.engines?.stalwart ?? 'full';
  if (mode === 'drop' || mode === 'route_only') return [];
  return rule.actions?.flags ?? [];
}

function effectiveFolder(folders: Record<string, string>, rule: Json): string | null {
  const mode = rule.engines?.stalwart ?? 'full';
  if (mode === 'drop' || mode === 'tag_only') return null;
  if (!(rule.actions && 'copy_to' in rule.actions)) return null;
  return folders[rule.actions.copy_to] ?? rule.actions.copy_to;
}

const isTagKind = (r: Json) => (r.kind ?? 'route') !== 'route';
const isRouteKind = (r: Json) => (r.kind ?? 'route') === 'route';

function sieveTagBlock(predicates: Record<string, Json>, account: string, rule: Json): string | null {
  const flags = effectiveFlags(rule);
  if (flags.length === 0) return null;
  const cond = sieveTest(account, resolvePredicate(predicates, rule.when));
  const lines = flags.map((f) => `addflag "${f}";`);
  return `# ${rule.id}\nif ${cond} {\n  ${lines.join('\n  ')}\n}`;
}

function sieveRouteBlock(
  predicates: Record<string, Json>, account: string,
  folders: Record<string, string>, inboxSeen: boolean, rule: Json,
): string | null {
  const folder = effectiveFolder(folders, rule);
  if (folder === null) return null;
  const cond = sieveTest(account, resolvePredicate(predicates, rule.when));
  const body = [
    ...effectiveFlags(rule).map((f) => `addflag "${f}";`),
    `fileinto :copy :create "${folder}";`,
    ...(inboxSeen ? [`addflag "\\\\Seen";`] : []),
    'stop;',
  ];
  return `# ${rule.id}\nif ${cond} {\n  ${body.join('\n  ')}\n}`;
}

export function toSieve(merged: Merged): string {
  const account = merged.account;
  const folders = allFolderTargets(merged);
  const predicates = merged.predicates;
  const requires = merged.sieve_require.map((e) => `"${e}"`).join(', ');
  const sorted = sortByPriority(merged.rules);
  const inboxSeen = merged.inbox_copy?.enabled ?? false;

  const tagLines = sorted.filter(isTagKind)
    .map((r) => sieveTagBlock(predicates, account, r))
    .filter((x): x is string => x !== null);
  const routeLines = sorted.filter(isRouteKind)
    .map((r) => sieveRouteBlock(predicates, account, folders, inboxSeen, r))
    .filter((x): x is string => x !== null);

  const defFolder = folders[merged.routing_default] ?? merged.routing_default;

  // No routing folders => no fallback. Without this guard the generator
  // emitted `fileinto :copy :create "others"` even with an empty `folders`
  // map, so the folder the config had just removed got recreated by Sieve on
  // the next delivery. Implicit keep already puts unmatched mail in INBOX.
  const hasRouting = Object.keys(folders).length > 0 && routeLines.length > 0;
  const fallbackBody = [
    `fileinto :copy :create "${defFolder}";`,
    ...(inboxSeen ? [`addflag "\\\\Seen";`] : []),
  ];
  const fallbackBlock = !hasRouting
    ? '# no routing folders — unmatched mail stays in INBOX via implicit keep'
    : '# fallback (no route matched)\n' + fallbackBody.join('\n');

  return `require [${requires}];

# ════════════════════════════════════════════════════════════════
# Generated by _shared/lib/derive-mail-rules.ts — DO NOT EDIT
# Source: mail-rules-general.json + profile overlay
# Semantic:
#   TAGS accumulate flags (visible to every fileinto + implicit keep).
#   ROUTES fileinto :copy :create then addflag \\Seen → only implicit
#   keep (INBOX) picks up \\Seen; category copies stay unread.
#   Fallback catches unmatched; implicit keep → INBOX as read.
# ════════════════════════════════════════════════════════════════

# ─── TAGS ───────────────────────────────────────────────────────
${tagLines.join('\n\n')}

# ─── ROUTES ─────────────────────────────────────────────────────
${routeLines.join('\n\n')}

# ─── FALLBACK ───────────────────────────────────────────────────
${fallbackBlock}
`;
}

// ── Maddy subset ────────────────────────────────────────────────────

/** The filters tree without the pattern-axis DECLARATIONS: they are expanded into views by [expandPatternAxes]. */
function withoutAxisDeclarations(f: Json): Json {
  const { axes_from_patterns: _expanded, ...rest } = f;
  return rest;
}

/**
 * The G0 _ AUTH axis as Maddy sorter rules: the SAME views the Stalwart
 * jmap-sorter files as JMAP folders ([authAxisViews], expanded into
 * `filters.views` by [expandPatternAxes]), one rule per view. Maddy evaluates
 * them first-match-wins in this order; the predicates are already exclusive.
 */
export function authAxisRules(merged: Merged): Json[] {
  const axes = new Set(((merged.filters?.axes_from_patterns ?? []) as Json[]).map((a: Json) => a.axis));
  return ((merged.filters?.views ?? []) as Json[])
    .filter((v: Json) => axes.has(v.axis))
    .map((v: Json) => ({ id: v.folder, when: v.predicate, folder: v.folder, axis: v.axis }));
}

export function toMaddyJson(merged: Merged): Json {
  const senderViews = (merged.filters?.views ?? []).filter((v: Json) => (v.axis ?? null) === 'sender');

  // Maddy gets ONLY the F* sender-classification folders, not the numeric
  // routing folders or the A-E axes. Each F view's own `predicate` IS the
  // delivery-time `when` tree unchanged.
  const senderRules = senderViews.map((v: Json) => ({ id: v.folder, when: v.predicate, folder: v.folder }));
  // Plus the G0 _ AUTH axis, when the rules declare it (`filters.axes_from_patterns`): an INDEPENDENT axis, so
  // a message gets one sender folder AND one auth folder. Its rules carry `axis: "auth"`; the sender rules
  // carry none (absent = sender), which keeps their bytes as they were.
  const rules = [...senderRules, ...authAxisRules(merged)];

  // Fz (the sender axis's own NOT-any-of-the-others catch-all) is deliberately
  // the true fallback: it matches exactly what nothing else does. Redundant
  // with first-match-wins ordering, but explicit as defense in depth if a
  // future edit reorders rules or empties the F axis.
  const fzView = senderViews.find((v: Json) => typeof v.folder === 'string' && v.folder.startsWith('Fz'));
  const defFolder = fzView ? fzView.folder : (merged.folders[merged.routing_default] ?? merged.routing_default);

  return {
    schema_version: 2,
    generated_by: '_shared/lib/derive-mail-rules.ts',
    account: merged.account,
    routing_default: defFolder,
    // Permanently unified-inbox: every message lands in INBOX (flagged per
    // inbox_copy_flags) and apply-rules COPIES an unread duplicate into the
    // matched F folder -- real IMAP COPY with independent flags per copy,
    // which JMAP/Stalwart cannot do (fileinto :copy shares one Email object).
    // Deliberately NOT derived from inbox_copy.enabled: that flag went false
    // for the JMAP fix, and coupling the two through one boolean silently
    // flipped Maddy's strategy to "split", undoing behaviour it really had.
    delivery_strategy: 'unified-inbox',
    inbox_copy_flags: merged.inbox_copy?.flags ?? ['\\Seen'],
    rules,
  };
}

// ── Legacy schema (what the jmap-sorter binary parses) ──────────────

export function toLegacyJson(merged: Merged): Json {
  const predicates = merged.predicates;
  const sorted = sortByPriority(merged.rules);

  // Routing: route-kind rules the sorter can evaluate at match time.
  //
  // This used to be `type == "from_domain"` only, with a comment claiming the
  // sorter understood nothing else. That was stale: crate/src/filters.rs
  // implements HeaderContains and FromDomainSuffix too, so 11 of 49 route
  // rules were dropped from the backfill for no reason -- "apply rules to all
  // mail" silently replayed 38 of them. SORTER_ATOMS is the real contract;
  // widen it only alongside filters.rs::atom_matches.
  const SORTER_ATOMS = new Set(['from_domain', 'from_domain_suffix', 'header_contains']);

  const routingFrom = (rule: Json): Json | null => {
    const mode = rule.engines?.stalwart ?? 'full';
    // Leaf names: this list feeds the Rust sorter, not Sieve.
    const folder = effectiveFolder(allFolderLeaves(merged), rule);
    const atom = resolvePredicate(predicates, rule.when);
    if (mode === 'drop' || folder === null) return null;
    if (!atom || typeof atom !== 'object' || !SORTER_ATOMS.has(atom.type)) return null;
    const match: Json = { type: atom.type };
    if (atom.header !== undefined) match.header = atom.header;
    match.values = atom.values;
    return { folder, match };
  };

  const routing = sorted.filter(isRouteKind).map(routingFrom).filter((x): x is Json => x !== null);

  const defFolder = merged.folders[merged.routing_default] ?? merged.routing_default;

  // Every from_domain a curated route claims for a NON-junk folder. Junk
  // routes are excluded or the carve-out would cancel itself out.
  const junkFolder = merged.folders.junk ?? null;
  const curatedDomains = unique(
    routing
      .filter((r) => (r.match?.type ?? '') === 'from_domain' && r.folder !== junkFolder)
      .flatMap((r) => r.match.values ?? []),
  );

  // Views carrying `excludes_curated_senders` get "AND NOT from a domain a
  // curated route claims" folded into their predicate. The two engines
  // disagree by construction: a route loses to a higher-priority rule and
  // stops, but a view has NO ordering -- membership is recomputed from the
  // predicate every poll. So `Ec Junk`, whose predicate is the same spam
  // heuristic as route.junk.spam_flagged, kept re-adding wg-gesucht mail no
  // matter how routes were ordered. Those senders genuinely fail SPF/DMARC
  // and the headers never change, so the predicate is the only place the
  // carve-out can live. The domain list is DERIVED from routing, never
  // restated -- a new curated route is automatically never junk.
  const curatedCarveOut = (f: Json): Json => {
    if (curatedDomains.length === 0) return f;
    return {
      ...f,
      views: (f.views ?? []).map((v: Json) =>
        v.excludes_curated_senders
          ? { ...v, predicate: { all_of: [v.predicate, { not: { type: 'from_domain', values: curatedDomains } }] } }
          : v,
      ),
    };
  };

  // `93 Junk` is a ROUTE (exclusive, first match wins, ends in `stop;`) while
  // `Ec Junk` is a VIEW (additive, recomputed every poll), so they can never
  // agree: any message a higher-priority route claimed never reaches the junk
  // route at priority 150, and 93 sat at 0 while Ec held 349 of the same spam.
  // Mirroring the carved-out Ec view onto 93 makes them identical BY
  // CONSTRUCTION -- one junk predicate, one carve-out, 93 derived not restated.
  // The route stays: it files spam at delivery time, the view keeps 93 in
  // agreement with Ec for everything already in the store.
  const junkMirror = (f: Json): Json => {
    const src = (f.views ?? []).find((v: Json) => v.excludes_curated_senders);
    if (junkFolder === null || !src) return f;
    return {
      ...f,
      views: [
        ...(f.views ?? []),
        {
          ...src,
          folder: junkFolder,
          // Its own axis: the priority axis is a hand-tiled partition
          // (Ea/Eb/Ec) and a second member would break Eb's NOT(Ec)/NOT(Ea).
          axis: 'junk_mirror',
          // Carve-out is already folded into src.predicate; leaving the flag
          // set would double-wrap it on any future re-application.
          excludes_curated_senders: false,
          _doc: 'Derived mirror of the Ec Junk view onto the 93 Junk route folder, so the additive view engine and the exclusive route engine report the same junk set. Do not hand-edit -- change the Ec view instead.',
        },
      ],
    };
  };

  // F0's sender folders must hold each message at most once (#502), but
  // views are additive: Fb and Fd both claimed linkedin.com, and Fg's promo
  // subjects re-caught Travel mail, so 39 live messages sat in two F folders.
  // First declared view wins: each sender view gets AND NOT(every earlier
  // one). Derived, not restated -- moving an overlapping domain is a
  // reorder of `views`, never a second hand-kept exclusion list.
  // ponytail: O(n^2) predicate size, fine for ~13 views.
  const senderPartition = (f: Json): Json => {
    const earlier: Json[] = [];
    return {
      ...f,
      views: (f.views ?? []).map((v: Json) => {
        if ((v.axis ?? null) !== 'sender') return v;
        const out = earlier.length ? { ...v, predicate: { all_of: [v.predicate, { not: { any_of: [...earlier] } }] } } : v;
        earlier.push(v.predicate);
        return out;
      }),
    };
  };

  return {
    account: merged.account,
    sieve_require: merged.sieve_require,
    // `folders` stays flat-only: group children are NOT flattened in, or
    // ensure_mailboxes would create them a second time as stray ROOT
    // mailboxes instead of nesting them under their parent.
    folders: merged.folders,
    folder_groups: merged.folder_groups ?? [],
    folders_ui: merged.folders_ui ?? [],
    root_folders: merged.root_folders ?? [],
    // The resolved tree, explicit. The Rust sorter applies it verbatim as
    // `parentId` rather than re-deriving the prefix rule -- one derivation,
    // one artifact, no drift between the two engines.
    folder_parents: folderParents(merged),
    routing_default: defFolder,
    // `axes_from_patterns` is a source declaration, already expanded into
    // section_headers + views by expandPatternAxes: the G0 _ AUTH JMAP
    // folders and filter views reach the jmap-sorter through those.
    filters: junkMirror(curatedCarveOut(senderPartition(withoutAxisDeclarations(merged.filters ?? { views: [], section_headers: [] })))),
    folder_renames: merged.folder_renames ?? { map: {} },
    folder_options: merged.folder_options ?? {},
    routing,
  };
}

// ── CLI ─────────────────────────────────────────────────────────────

// import.meta.url, not __dirname: this file is loaded as ESM (it uses
// import/export, which Node's type-stripping auto-detects as module scope,
// where __dirname does not exist) by both tsx and plain `node file.ts`.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const STALWART = path.join(ROOT, 'user-comm_tools-stalwart');
const MADDY = path.join(ROOT, 'user-comm_tools-maddy');

interface Artifact {
  file: string;
  content: string;
}

function artifacts(): Artifact[] {
  const merged = loadAndMerge(
    path.join(STALWART, 'src', 'mail-rules-general.json'),
    path.join(STALWART, 'src', 'mail-rules-profile-diego.json'),
  );
  return [
    // Compact, sorted keys, NO trailing newline: matches builtins.toJSON, so
    // the committed asset does not churn on formatting alone.
    { file: path.join(STALWART, 'dist', 'assets', 'mail-rules.json'), content: stableStringify(toLegacyJson(merged)) },
    { file: path.join(MADDY, 'dist', 'assets', 'mail-rules.json'), content: stableStringify(toMaddyJson(merged)) },
    // src/templates/, not dist/: this is the engine's own file-based template
    // path (renderTemplate reads templates/<name>.tpl), so the flake only has
    // to NAME the file. The engine still prepends its dist banner and writes
    // dist/configs/default.sieve, byte-identical to what the inline
    // `text = sieveScript` produced.
    { file: path.join(STALWART, 'src', 'templates', 'default.sieve.tpl'), content: toSieve(merged) },
  ];
}

/**
 * Golden-capture mode: write the two artifacts the test suite diffs, into a
 * scratch dir, under the names the goldens use. Keeps run-tests.sh from
 * reaching into this module's internals — and replaces the nix-instantiate +
 * jq pipeline the goldens used to be captured through.
 *
 * maddy.json is pretty-printed here because the committed golden was captured
 * through `jq`, which is what set that format.
 */
function emitForTests(dir: string) {
  const merged = loadAndMerge(
    path.join(STALWART, 'src', 'mail-rules-general.json'),
    path.join(STALWART, 'src', 'mail-rules-profile-diego.json'),
  );
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'stalwart.sieve'), toSieve(merged));
  fs.writeFileSync(path.join(dir, 'maddy.json'), prettyStringify(toMaddyJson(merged)) + '\n');
  // Not a golden — the suite asserts the sieve's fileinto paths against the
  // tree in here, which is what catches a folder that got nested without its
  // Sieve path being regenerated. That combination compiles perfectly and
  // misfiles every message it touches.
  fs.writeFileSync(path.join(dir, 'stalwart-rules.json'), prettyStringify(toLegacyJson(merged)) + '\n');
}

function main() {
  const emitIdx = process.argv.indexOf('--emit');
  if (emitIdx >= 0) {
    const dir = process.argv[emitIdx + 1];
    if (!dir) { console.error('--emit needs a directory'); process.exit(2); }
    emitForTests(dir);
    return;
  }

  const check = process.argv.includes('--check');
  let drift = 0;

  for (const a of artifacts()) {
    const rel = path.relative(ROOT, a.file);
    const existing = fs.existsSync(a.file) ? fs.readFileSync(a.file, 'utf8') : null;
    if (existing === a.content) {
      console.log(`  ok        ${rel}`);
      continue;
    }
    if (check) {
      drift++;
      console.log(`  DRIFT     ${rel} (${existing === null ? 'missing' : `${existing.length} -> ${a.content.length} bytes`})`);
      continue;
    }
    fs.mkdirSync(path.dirname(a.file), { recursive: true });
    fs.writeFileSync(a.file, a.content);
    console.log(`  written   ${rel}`);
  }

  if (check && drift > 0) {
    console.error(`\n${drift} artifact(s) differ from the canonicals — run without --check to regenerate.`);
    process.exit(1);
  }
}

// ESM equivalent of `require.main === module`: true when this file was
// invoked directly (`node derive-mail-rules.ts`), false when imported.
if (import.meta.url === `file://${process.argv[1]}`) main();
