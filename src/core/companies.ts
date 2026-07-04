/**
 * FounderOS — Company registry (multi-business)
 * ==============================================
 * One profile per business the office can run. Credentials already resolve
 * per-company via the account registry (ADR-036); this registry parameterizes
 * the *voice* — brand identity + ICP + which knowledge store holds the facts —
 * so the same locked graph can speak for Turicks or Naggar without a rebuild.
 *
 * Design (rule #16 / #22):
 * - Pure data + pure functions — no LLM, no I/O, fully unit-testable.
 * - The block NEVER invents ICP bands, clients, or numbers. It states public
 *   identity + voice + WHERE the specifics live (the knowledge store), then
 *   defers to the department tools to fetch them. Anti-fabrication by design.
 * - The default boot tenant (Turicks) emits an EMPTY override — the supervisor
 *   prompt already *is* Turicks, so the cacheable prefix (rule #20) stays
 *   byte-stable and production behavior is unchanged.
 *
 * See ADR-036 (account registry) and the multi-business plan.
 */

import { TENANT } from "./config.js";

export interface CompanyProfile {
  /** Stable key — matches an AccountKey where credentials are resolved. */
  key: string;
  /** Public-facing display name. */
  displayName: string;
  /** One-line public description (safe to state without a KB lookup). */
  tagline: string;
  /** How this company speaks — tone directive for outbound copy. */
  brandVoice: string;
  /** Who it serves, in public terms — never invented bands/numbers. */
  audience: string;
  /** Knowledge store that holds the durable internal facts for this company. */
  knowledgeStore: string;
}

/**
 * The registry. Add a business here + an account in ACCOUNT_SEED_SPECS and the
 * office can run it. Turicks is the default (boot) tenant.
 */
export const COMPANY_PROFILES: Readonly<Record<string, CompanyProfile>> = {
  turicks: {
    key: "turicks",
    displayName: "Turicks",
    tagline: "The Autonomous Studio — cinematic launch experiences for AI/dev-tool startups.",
    brandVoice:
      "Terse senior-operator voice. Direct, confident, human. No corporate filler, no hype, no emoji.",
    audience: "AI and developer-tool startups preparing a launch.",
    knowledgeStore: "turicks-brain",
  },
  naggar: {
    key: "naggar",
    displayName: "Naggar Retreat",
    tagline: "A grounded mountain retreat in Naggar, Himachal.",
    brandVoice:
      "Warm, calm, place-led hospitality voice. Grounded and inviting, never salesy or buzzwordy. Plain language, no emoji.",
    audience: "Guests seeking a quiet, restorative stay in the Himalayas.",
    knowledgeStore: "turicks-brain",
  },
};

/** The default company — the boot tenant. */
export const DEFAULT_COMPANY_KEY = TENANT;

export function isCompanyKey(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(COMPANY_PROFILES, value.trim().toLowerCase());
}

/**
 * Resolve a company profile by key, falling back to the boot tenant (or Turicks
 * if the tenant itself is unknown). Never throws — routing must stay deterministic.
 */
export function getCompany(key?: string): CompanyProfile {
  const k = (key ?? DEFAULT_COMPANY_KEY).trim().toLowerCase();
  return COMPANY_PROFILES[k] ?? COMPANY_PROFILES[DEFAULT_COMPANY_KEY] ?? COMPANY_PROFILES["turicks"]!;
}

/**
 * Build the per-turn company-context override injected ahead of the user
 * message when the active company is NOT the default boot tenant. For the
 * default tenant this returns "" — the supervisor prompt already carries that
 * identity, so no injection (cache-stable, zero behavior change).
 */
export function buildCompanyContextBlock(company: CompanyProfile): string {
  if (company.key === DEFAULT_COMPANY_KEY) return "";
  return (
    `ACTIVE COMPANY OVERRIDE — this turn runs for ${company.displayName}, NOT Turicks.\n` +
    `- Identity: ${company.displayName} — ${company.tagline}\n` +
    `- Audience: ${company.audience}\n` +
    `- Voice for any drafted copy: ${company.brandVoice}\n` +
    `- Internal facts (specifics, history, offerings) live in ${company.knowledgeStore} — ` +
    `route to admin/research to look them up. NEVER invent details about ${company.displayName}. ` +
    `If the knowledge store has nothing, say so plainly.`
  );
}
