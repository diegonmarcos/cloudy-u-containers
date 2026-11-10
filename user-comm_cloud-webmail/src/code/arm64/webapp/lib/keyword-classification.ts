/**
 * Classifying a tag by its display name (#1590).
 *
 * The mail client splits the tags on a message into two families so the reading
 * panel can show them apart - "Project" tags front and centre, "Meta" tags
 * tucked away:
 *
 *   - META tags    - a display name that starts with an uppercase letter
 *                    `A`-`Z` immediately followed by `*` (e.g. `A*Important`,
 *                    `Z*Archive`).
 *   - PROJECT tags - a display name that starts with a digit `1`-`9`
 *                    immediately followed by `*` (e.g. `1*Website`, `9*Ops`).
 *                    `0*` is deliberately excluded, matching the `1`-`9` rule.
 *
 * Anything else is `other`: an ordinary tag that belongs to neither family and
 * stays visible rather than being hidden behind a classification it never
 * opted into.
 *
 * Classification is purely on the *name the user sees* - what `useKeywordFormat`
 * resolves a tag id to - never on the raw JMAP keyword id, so a tag reads the
 * same way here as it does everywhere else in the UI. The functions are pure
 * and server-independent, so the same split is used by the panel, the sidebar
 * and anything else that needs it.
 */

/** Which family a tag's name puts it in. */
export type TagClass = "meta" | "project" | "other";

/** A name beginning with an A-Z letter and then `*` marks a META tag. */
const META_NAME_RE = /^[A-Z]\*/;

/** A name beginning with a 1-9 digit and then `*` marks a PROJECT tag. */
const PROJECT_NAME_RE = /^[1-9]\*/;

/** The family a single display name belongs to. */
export function classifyTagName(name: string): TagClass {
  if (META_NAME_RE.test(name)) return "meta";
  if (PROJECT_NAME_RE.test(name)) return "project";
  return "other";
}

/** True when the display name marks a META tag (`A*`-`Z*`). */
export function isMetaTagName(name: string): boolean {
  return META_NAME_RE.test(name);
}

/** True when the display name marks a PROJECT tag (`1*`-`9*`). */
export function isProjectTagName(name: string): boolean {
  return PROJECT_NAME_RE.test(name);
}

/** The three families, each holding the items that fell into it, order kept. */
export interface ClassifiedTags<T> {
  meta: T[];
  project: T[];
  other: T[];
}

/**
 * Split items into the three families by the name `nameOf` resolves each to.
 * The incoming order is preserved within every family, so a caller that sorted
 * its ids keeps that sort inside each group.
 */
export function classifyTags<T>(
  items: T[],
  nameOf: (item: T) => string,
): ClassifiedTags<T> {
  const meta: T[] = [];
  const project: T[] = [];
  const other: T[] = [];
  for (const item of items) {
    switch (classifyTagName(nameOf(item))) {
      case "meta":
        meta.push(item);
        break;
      case "project":
        project.push(item);
        break;
      default:
        other.push(item);
    }
  }
  return { meta, project, other };
}

/**
 * Convenience over `classifyTags` for the common case of tag ids plus a
 * name resolver (e.g. `useKeywordFormat().tagName`).
 */
export function classifyTagIds(
  ids: string[],
  nameOf: (id: string) => string,
): ClassifiedTags<string> {
  return classifyTags(ids, nameOf);
}
