/**
 * FounderOS — screen_job tool
 * ===========================
 * The gate the whole NL entry campaign hangs off
 * (docs/strategy/09-NL-ENTRY-CAMPAIGN.md §3). It applies the deterministic
 * filters to one posting BEFORE any model spend or founder attention, and
 * records the verdict in `job_applications`.
 *
 * The tool takes the posting TEXT and parses it here, in code. It deliberately
 * does not accept salary numbers from the caller: the model reads "€4.500" as
 * four-point-five often enough that letting it supply the figure would reject the
 * entire Dutch market as sub-floor. Parsing is a pure unit-tested function
 * (extract.ts), never a prompt instruction.
 *
 * A posting is screened under EVERY permit basis that could lawfully carry it
 * (permit-routes.ts), and the best outcome wins. Screening under one basis and
 * calling that the answer is what made the screener reject Netherlands roles that
 * were perfectly reachable on a partner permit — and a rejected posting emits no
 * signal that rejecting it was wrong.
 */

import { TENANT } from "../../core/config.js";
import { getProfile, type JobSearchProfile } from "./profile-config.js";
import { childLogger } from "../../infra/logger.js";
import { matchSponsor, type SponsorMatch } from "./sponsor-match.js";
import { getSponsorRegister, registerStaleness } from "./sponsor-registry.js";
import { extractPostingFacts, type PostingRoute } from "./extract.js";
import { countryFromLocation, type PostingCountry } from "./country.js";
import { screenIndianPay } from "./pay-india.js";
import { basesForPosting, gateProfile, isLiveBasis, nonLiveBasisRejectGate } from "./permit-routes.js";
import { THIN_BODY_CHARS, postingGate, basisGate, locationGate, sponsorGate } from "./screen-gates.js";
import {
  dedupeKey,
  isStaleEnoughToReapply,
  screenLanguage,
  screenSalaryFacts,
  softDedupeKey,
  type ScreenRoute,
  type ScreenStatus,
} from "./filters.js";
import {
  findApplicationByDedupeKey,
  findApplicationsBySoftKey,
  recordScreenedApplication,
} from "../../db/job-queries.js";
import { recordSignals, UNCLASSIFIED_TRACK } from "../../db/cv-signal-queries.js";
import { classifyTrack } from "./tracks.js";
import { signalsForPosting } from "./skills.js";
import { experienceGate } from "./experience.js";
import { combineVerdict, serialiseGates, type Gate, type ScreenVerdict } from "./gates.js";
import { formatScreenOutcome } from "./screen-format.js";
import type { JobApplication } from "../../db/schema.js";
import type { UnifiedTool, ToolResult } from "../index.js";

const log = childLogger({ module: "tool:screen_job" });

// Re-exported so callers keep one import site for the screening vocabulary.
export { combineVerdict } from "./gates.js";
export { formatScreenOutcome } from "./screen-format.js";
// Re-exported so every existing import of these gates keeps resolving here.
export { THIN_BODY_CHARS, postingGate, basisGate, locationGate, sponsorGate } from "./screen-gates.js";
export type { Gate, ScreenVerdict } from "./gates.js";

/** Stages that mean the founder has already engaged — never silently re-screen over them. */
const ENGAGED_STAGES = new Set(["drafted", "awaiting_approval", "applied", "replied"]);

/** Which concrete routes to screen a posting under. `unclear` gets both. */
export function routesToScreen(route: PostingRoute, profile: JobSearchProfile = getProfile()): ScreenRoute[] {
  return basesForPosting(route, profile);
}

/**
 * Pick the outcome across the routes a posting was screened under.
 *
 * The best route wins, because a posting that is viable EITHER way is viable. An
 * unclear posting that fails the sponsor gate but clears the contract rate is a
 * real opportunity, and the old single-route design discarded it.
 */
export function bestOutcome<T extends { verdict: ScreenVerdict }>(outcomes: readonly T[]): T {
  const rank: Record<ScreenStatus, number> = { pass: 0, flag: 1, reject: 2 };
  // Ties break on the number of gates still open, not on array position. Once
  // the shared Location gate started flagging every basis of an `unclear`
  // posting, all three tied — and the winner became whichever came first in
  // LIVE_PERMIT_BASES, which is HSM. That recorded the posting under the basis
  // carrying the MOST unanswered questions (Location and Sponsor) rather than
  // the fewest (Location alone), so the brief asked the founder about a
  // recognised-sponsor register on a role that may never need one.
  const openGates = (o: T): number => o.verdict.gates.filter((g) => g.status !== "pass").length;
  return [...outcomes].sort(
    (a, b) => rank[a.verdict.status] - rank[b.verdict.status] || openGates(a) - openGates(b),
  )[0]!;
}

// ── The gates, as a function ──────────────────────────────────────────────────

export interface PostingInput {
  readonly company: string;
  readonly title: string;
  readonly url?: string;
  readonly description: string;
  /** manual | ats-ingest | indeed-ingest — recorded so the funnel splits by source. */
  readonly source?: string;
  /** Employer's publication date, when the source provides one. */
  readonly postedAt?: Date;
  /** The source's own id, when it has one — Indeed's job key powers liveness. */
  readonly externalId?: string;
  /**
   * Where the FETCHER says this job is. Supplied when the source knows for
   * certain — the Indeed sweep knows which country it queried — and preferred
   * over anything derivable from `location` or from the ad's prose.
   */
  readonly country?: PostingCountry;
  /** The feed's own location string, when there is one. Read only if `country` is absent. */
  readonly location?: string;
  /** Profile context for multi-profile screening. */
  readonly profile?: JobSearchProfile;
}

export type ScreenOutcome =
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "duplicate";
      readonly company: string;
      readonly title: string;
      readonly stage: string;
      readonly appliedAt: Date | null;
    }
  | {
      readonly kind: "screened";
      readonly company: string;
      readonly title: string;
      readonly route: ScreenRoute;
      /** ai | backend | frontend | unclassified — which market this posting is in. */
      readonly track: string;
      readonly verdict: ScreenVerdict;
      readonly routesTried: number;
      readonly match: SponsorMatch;
      readonly nearDuplicates: readonly JobApplication[];
      /**
       * Whether the tracker had never seen this posting before.
       *
       * Free: the existing row is already loaded above to check for engagement.
       * Reported because the feed bills per job RETURNED, so a sweep that
       * re-buys yesterday's inventory costs full price — and on 2026-08-02 one
       * did, screening 27 postings for $0.4682 and adding zero rows. Without
       * this flag that morning was indistinguishable from a productive one.
       */
      readonly isNew: boolean;
    };

/**
 * Apply every gate to one posting and record the verdict.
 *
 * This is the single screening path. `screen_job` (founder pastes a posting) and
 * `ingest_jobs` (the daily sweep) both call it, and neither reimplements any part
 * of it — two implementations of the same gates would drift, and the drift would
 * be invisible: both paths would keep returning confident verdicts.
 */
export async function screenPosting(input: PostingInput): Promise<ScreenOutcome> {
  const profile = input.profile ?? getProfile();
  const company = input.company.trim();
  const title = input.title.trim();
  if (company.length === 0 || title.length === 0) {
    return { kind: "error", message: "screen_job needs both a company and a title." };
  }

  const description = input.description;
  const key = dedupeKey(company, title);
  const softKey = softDedupeKey(company, title);

  // Duplicate check first — cheapest gate, most embarrassing failure.
  let existing: JobApplication | null = null;
  let nearDuplicates: JobApplication[] = [];
  try {
    existing = await findApplicationByDedupeKey(key, profile.tenantId ?? TENANT, profile.id);
    nearDuplicates = await findApplicationsBySoftKey(softKey, key, profile.tenantId ?? TENANT, profile.id);
  } catch (err) {
    return { kind: "error", message: `Application tracker unreachable: ${(err as Error).message}` };
  }

  if (
    existing &&
    ENGAGED_STAGES.has(existing.stage) &&
    !isStaleEnoughToReapply(existing.applied_at ?? null, new Date())
  ) {
    return {
      kind: "duplicate",
      company,
      title,
      stage: existing.stage,
      appliedAt: existing.applied_at ?? null,
    };
  }

  // WHERE THE JOB IS, AS A FETCHED FACT. The caller's explicit country wins (the
  // Indeed sweep knows whether it queried NL or IN); otherwise it is read off the
  // feed's own location string. Only when neither exists does anything downstream
  // fall back to the ad's wording — which is what used to file Indian roles as
  // Dutch ones on the strength of the word "hybrid".
  const country = input.country ?? countryFromLocation(input.location ?? "", profile);
  const facts = extractPostingFacts(description, country);

  let register: ReturnType<typeof getSponsorRegister>;
  try {
    register = getSponsorRegister();
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }
  const stale = registerStaleness(register.scrapedAt);
  const match = matchSponsor(company, register.index);
  const language = screenLanguage(description);

  // Screen under every basis that could lawfully carry this posting; the best
  // outcome wins. A role rejected on one basis and reachable on another is a real
  // opportunity, and the single-basis design discarded it without a trace.
  // Level and body-completeness do not vary by permit basis, so they are built
  // once and shared across the routes rather than recomputed per route.
  const experience = experienceGate(description, title, profile);
  const posting = postingGate(description);
  // Where the job sits is a fact about the posting, not about any one basis, so
  // it is reported once for all of them — see locationGate in screen-gates.ts.
  const location = locationGate(country, facts.route);

  // The IND recognised-sponsor register is Dutch-immigration-specific. A basis
  // marked sponsorRequired (currently only "hsm") is only meaningful for a
  // profile that actually targets the Netherlands — a future profile targeting
  // Germany/UK/US with its own "hsm"-shaped basis must not be screened against
  // Dutch law. Guarded here rather than in permit-routes.ts because the register
  // itself (sponsor-registry.ts) is hardcoded to the IND CSV; this flag is the
  // seam that stops it from running for a market it has no data for.
  const targetsNetherlands = profile.targetCountries.some((c) => c.code === "NL");

  const outcomes = routesToScreen(facts.route, profile).map((route) => {
    // A non-live basis here means a DEFINITE route matched nothing this
    // profile holds (see nonLiveBasisRejectGate) — found live, 2026-09-04,
    // carrying a Bangalore posting under a Dutch permit.
    if (!isLiveBasis(route, profile)) {
      return { route, verdict: combineVerdict([nonLiveBasisRejectGate(route, profile)]) };
    }
    const gProfile = gateProfile(route);
    // Each market is judged by its own numbers. A rupee figure against a euro
    // reference is not approximately right, it is a different currency — so the
    // pay gate is SELECTED by the basis rather than parameterised by it.
    const pay: Gate =
      gProfile.payReference === "inr"
        ? { gate: "Pay", ...screenIndianPay(facts.pay, (profile.minInrLpaFloor ?? 15) * 100_000) }
        : {
            gate: gProfile.salaryFloorApplies ? "Salary" : "Rate",
            // The CANDIDATE's date of birth, not the founder's — the IND floor
            // steps up 36% at thirty and the band is a fact about the person.
            ...screenSalaryFacts(facts.salary, { route, dob: profile.dob }),
          };
    const runSponsorGate = gProfile.sponsorRequired && targetsNetherlands;
    const gates: Gate[] = [
      ...(posting ? [posting] : []),
      ...(location ? [location] : []),
      runSponsorGate ? sponsorGate(match, stale) : basisGate(gProfile),
      pay,
      // Omitted entirely where it cannot apply. "✅ No Dutch-language requirement
      // mentioned" on a Bangalore posting is a cleared check about a language
      // nobody asked for — noise wearing the costume of information.
      ...(gProfile.dutchLanguageApplies ? [{ gate: "Language", ...language }] : []),
      experience,
    ];
    return { route, verdict: combineVerdict(gates) };
  });

  const chosen = bestOutcome(outcomes);

  // Derived here rather than taken from the caller, for the same reason the
  // gates are: `screen_job` and `ingest_jobs` must classify identically, and a
  // caller-supplied track would drift silently between the two paths.
  const track = classifyTrack(title, profile) ?? UNCLASSIFIED_TRACK;

  try {
    await recordScreenedApplication({
      tenant_id: profile.tenantId ?? TENANT,
      profile_id: profile.id,
      dedupe_key: key,
      soft_dedupe_key: softKey,
      company,
      registered_name: match.registered_name ?? null,
      title,
      url: input.url ?? null,
      route: chosen.route,
      track,
      sponsor_verdict: match.verdict,
      salary_status: chosen.verdict.status,
      salary_evidence: chosen.verdict.reasons.join(" | ").slice(0, 2000),
      // The gates WITH their statuses. `salary_evidence` above is the same
      // information flattened for human eyes and is kept for that; it is not the
      // source the brief reads, because a flat string cannot say which check
      // failed — which is precisely how a passing sponsor line ended up printed
      // as the reason a row needed attention.
      gate_json: serialiseGates(chosen.verdict.gates),
      stage: "screened",
      description: description.slice(0, DESCRIPTION_MAX),
      posted_at: input.postedAt ?? null,
      source: input.source ?? "manual",
      external_id: input.externalId ?? null,
      // Stored, not re-derived at render time. The brief splits the two markets
      // on this column, and re-guessing it from the ad later would reintroduce
      // exactly the inference this column exists to replace.
      country,
      location: input.location ?? null,
    });
  } catch (err) {
    return {
      kind: "error",
      message: `Screened "${company} · ${title}" but could not record it: ${(err as Error).message}`,
    };
  }

  // Only postings that clear every gate feed the CV signal table. Roles Pushkar
  // cannot legally hold describe a market he cannot enter, and letting them vote
  // on what his CV should say is how a gap report ends up recommending skills for
  // jobs that would be rejected on the sponsor gate anyway.
  if (chosen.verdict.status === "pass") {
    try {
      await recordSignals(signalsForPosting(description, company, profile.skillsDictionaryName), { track });
    } catch (err) {
      // allow-failopen: a lost frequency count must never discard a screening
      // verdict. The verdict is the decision; signals are the running average.
      log.warn({ company, title, err: (err as Error).message }, "CV signal recording failed");
    }
  }

  log.info(
    {
      company,
      title,
      route: chosen.route,
      track,
      verdict: chosen.verdict.status,
      detectedRoute: facts.route,
    },
    "Job screened",
  );

  return {
    kind: "screened",
    company,
    title,
    route: chosen.route,
    track,
    verdict: chosen.verdict,
    routesTried: outcomes.length,
    match,
    nearDuplicates,
    isNew: existing === null,
  };
}

/** Bound the stored posting body — enough to re-derive signals, not enough to bloat rows. */
const DESCRIPTION_MAX = 20_000;

export const screenJobTool: UnifiedTool = {
  name: "screen_job",
  description:
    "Screen ONE job posting against the hard gates before drafting anything: IND " +
    "recognised-sponsor register, the permit salary floor, Dutch-language requirement, " +
    "and duplicate-application check. Screens both the sponsorship route and the " +
    "remote-contract route. Pass the posting text verbatim in `description` — salary and " +
    "hours are parsed from it in code, so do NOT interpret figures yourself. Read-mostly, " +
    "no approval needed. Call this before writing any cover letter.",
  input_schema: {
    type: "object",
    properties: {
      company: { type: "string", description: "Employer name exactly as it appears on the posting." },
      title: { type: "string", description: "Role title, e.g. 'Senior AI Engineer'." },
      url: { type: "string", description: "Link to the posting." },
      description: {
        type: "string",
        description:
          "The posting text, VERBATIM and unsummarised. Salary, hours, language requirement " +
          "and remote/on-site status are all parsed from this. Do not paraphrase figures.",
      },
    },
    required: ["company", "title", "description"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const outcome = await screenPosting({
      company: String(args["company"] ?? ""),
      title: String(args["title"] ?? ""),
      description: String(args["description"] ?? ""),
      ...(args["url"] ? { url: String(args["url"]) } : {}),
      source: "manual",
    });
    if (outcome.kind === "error") return { success: false, error: outcome.message };
    return { success: true, data: formatScreenOutcome(outcome) };
  },
};
