/**
 * FounderOS — Social mention / LinkedIn "little text" builder (PURE)
 * ==================================================================
 * Two layers:
 *   1. buildCommentary — structured org URN annotations for linkedin-direct.ts
 *   2. appendCompanyPageMention — plain @CompanyName for scheduled personal posts
 *
 * LinkedIn encodes an organization mention inline in commentary as:
 *   "…body… @[Exact Org Name](urn:li:organization:2414183)"
 * The visible name MUST match the organization's name (case-sensitive) or it
 * renders as plain text. When ANY annotation is present, LinkedIn parses the
 * ENTIRE commentary as "little text", so reserved structural characters in the
 * body must be escaped or they corrupt annotation parsing.
 *
 * This module is deterministic + side-effect-free (v3 invariant: routing/parsing
 * lives in unit-tested functions, never a prompt instruction).
 */

import { readEnvValue } from "./credential-resolver.js";

const DEFAULT_ORG_NAME = "Turicks";

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
 *
 * This is the FULL reserved set per LinkedIn's little-text grammar (Text ::=
 * NON_RESERVED_CHAR_SEQUENCES | "\|" | "\{" | "\}" | "\@" | "\[" | "\]" | "\("
 * | "\)" | "\<" | "\>" | "\#" | "\\" | "\*" | "\_" | "\~" — see
 * learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/
 * little-text-format). The list previously stopped at ()[]{}@|# and omitted
 * <>*_~ — LinkedIn's own docs show plain "*" bullets need escaping ("\* Point
 * 1"). Any of those left unescaped in a commentary that ALSO carries a mention
 * annotation breaks the little-text parser: LinkedIn renders only the text up
 * to the corruption, so a fully-approved multi-paragraph draft (which commonly
 * contains *, _, or ~ from LLM-style emphasis/bullets) publishes as just its
 * first line or two.
 */
const LITTLE_TEXT_SPECIALS = [
  "\\",
  "|",
  "{",
  "}",
  "@",
  "[",
  "]",
  "(",
  ")",
  "<",
  ">",
  "#",
  "*",
  "_",
  "~",
] as const;

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

/** Company display name for @mentions (env: LINKEDIN_ORG_NAME). */
export function getCompanyPageName(): string {
  return readEnvValue("LINKEDIN_ORG_NAME")?.trim() || DEFAULT_ORG_NAME;
}

/** Org URN for Turicks company page (env: LINKEDIN_ORG_URN) — used when posting as org. */
export function getCompanyPageUrn(): string | undefined {
  return readEnvValue("LINKEDIN_ORG_URN")?.trim() || undefined;
}

/**
 * Append @CompanyName to post text when posting from personal profile for growth.
 * Idempotent — skips if mention already present (case-insensitive).
 */
export function appendCompanyPageMention(text: string, orgName = getCompanyPageName()): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  const needle = `@${orgName}`;
  if (trimmed.toLowerCase().includes(needle.toLowerCase())) return trimmed;
  return `${trimmed}\n\n${needle}`;
}
