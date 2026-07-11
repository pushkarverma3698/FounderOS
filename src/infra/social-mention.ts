/**
 * FounderOS — Social @mention helpers
 * ====================================
 * LinkedIn has no schedule API; tagging uses plain-text @CompanyName in commentary
 * until structured mention entities are wired in linkedin-direct.ts.
 */

import { readEnvValue } from "./credential-resolver.js";

const DEFAULT_ORG_NAME = "Turicks";

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
