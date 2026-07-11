/**
 * FounderOS — Social mention / LinkedIn "little text" builder (PURE)
 * ==================================================================
 * Builds the `commentary` field for the LinkedIn Posts API, optionally
 * @tagging an organization (Company Page) from a personal-authored post.
 *
 * LinkedIn encodes an organization mention inline in commentary as:
 *   "…body… @[Exact Org Name](urn:li:organization:2414183)"
 * The visible name MUST match the organization's name (case-sensitive) or it
 * renders as plain text. When ANY annotation is present, LinkedIn parses the
 * ENTIRE commentary as "little text", so reserved structural characters in the
 * body must be escaped or they corrupt annotation parsing.
 * See docs/decisions/009 + the Posts API "Mentions and Hashtags" section.
 *
 * This module is deterministic + side-effect-free (v3 invariant: routing/parsing
 * lives in unit-tested functions, never a prompt instruction).
 */

/** An organization the post should @tag (Company Page). */
export interface MentionTarget {
  /** Organization URN, e.g. "urn:li:organization:2414183". */
  urn: string;
  /** Exact page name — must match LinkedIn's org name for the link to resolve. */
  name: string;
}

/** True for a well-formed organization URN (the only mention type we support). */
export function isOrganizationUrn(urn: string): boolean {
  return /^urn:li:organization:[A-Za-z0-9]+$/.test(urn.trim());
}

/**
 * Structural characters that break LinkedIn little-text annotation parsing.
 * Escaping these (backslash-prefix) makes body text render literally while a
 * deliberately-injected annotation still resolves. Backslash is escaped first
 * so we never double-process an escape we just added.
 */
const LITTLE_TEXT_SPECIALS = ["\\", "(", ")", "[", "]", "{", "}", "@", "|", "#"] as const;

/** Escape reserved little-text characters in free-form body text. */
export function escapeLittleText(text: string): string {
  let out = text;
  for (const ch of LITTLE_TEXT_SPECIALS) {
    out = out.split(ch).join(`\\${ch}`);
  }
  return out;
}

/**
 * Build the `commentary` payload for a post.
 *
 * - No mention → return text UNCHANGED. This preserves the existing plain-post
 *   behavior byte-for-byte (a post with no tag is not little-text, so its `(`,
 *   `#`, `@` characters must not be escaped).
 * - With mention → escape the body, then append the org annotation on its own
 *   line so the Company Page is tagged at the end of the post.
 */
export function buildCommentary(text: string, mention?: MentionTarget): string {
  if (!mention) return text;
  const body = escapeLittleText(text).trimEnd();
  const annotation = `@[${mention.name}](${mention.urn})`;
  return body ? `${body}\n\n${annotation}` : annotation;
}
