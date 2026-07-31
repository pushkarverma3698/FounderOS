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

import { childLogger } from "../../infra/logger.js";
import { matchSponsor, type SponsorMatch } from "./sponsor-match.js";
import { getSponsorRegister, registerStaleness } from "./sponsor-registry.js";
import { extractPostingFacts, type PostingRoute } from "./extract.js";
import { basesForPosting, gateProfile } from "./permit-routes.js";
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
import type { JobApplication } from "../../db/schema.js";
import type { UnifiedTool, ToolResult } from "../index.js";

const log = childLogger({ module: "tool:screen_job" });

/** Stages that mean the founder has already engaged — never silently re-screen over them. */
const ENGAGED_STAGES = new Set(["drafted", "awaiting_approval", "applied", "replied"]);

interface Gate {
  readonly gate: string;
  readonly status: ScreenStatus;
  readonly evidence: string;
}

export interface ScreenVerdict {
  readonly status: ScreenStatus;
  /** One line per gate, in the order they were applied. */
  readonly reasons: readonly string[];
}

/**
 * Combine the individual gate results into one verdict.
 * `reject` is absorbing — one legally impossible gate makes the posting void
 * regardless of how well it scores elsewhere.
 */
export function combineVerdict(gates: readonly Gate[]): ScreenVerdict {
  const reasons = gates.map((g) => `${g.gate}: ${g.evidence}`);
  if (gates.some((g) => g.status === "reject")) return { status: "reject", reasons };
  if (gates.some((g) => g.status === "flag")) return { status: "flag", reasons };
  return { status: "pass", reasons };
}

/** Which concrete routes to screen a posting under. `unclear` gets both. */
export function routesToScreen(route: PostingRoute): ScreenRoute[] {
  return basesForPosting(route);
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
  return [...outcomes].sort((a, b) => rank[a.verdict.status] - rank[b.verdict.status])[0]!;
}

export function sponsorGate(match: SponsorMatch, stale: ReturnType<typeof registerStaleness>): Gate {
  // A stale register cannot invent a sponsor, so a positive stays valid. A
  // NEGATIVE from a stale file is a hard reject of a company that may have been
  // recognised since — downgrade it to a human check rather than a silent drop.
  if (match.verdict === "not-sponsor" && stale.stale) {
    return {
      gate: "Sponsor",
      status: "flag",
      evidence: `${match.evidence} BUT this cannot be trusted: ${stale.note}`,
    };
  }

  // Absence from the register FLAGS rather than rejects (founder decision,
  // 2026-07-31). Recognition costs an employer roughly €4,500 and about four
  // weeks, and companies do take it on for someone they want — so "not a sponsor
  // today" is not "cannot hire you". Rejecting made that permanently invisible;
  // a flag keeps it a decision Pushkar gets to make.
  if (match.verdict === "not-sponsor") {
    return {
      gate: "Sponsor",
      status: "flag",
      evidence:
        `${match.evidence} They could still become one (~€4,500, ~4 weeks) — worth asking ` +
        `if the role is otherwise strong, rather than assuming no.`,
    };
  }

  const status: ScreenStatus = match.verdict === "sponsor" ? "pass" : "flag";
  return { gate: "Sponsor", status, evidence: match.evidence };
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
    existing = await findApplicationByDedupeKey(key);
    nearDuplicates = await findApplicationsBySoftKey(softKey, key);
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

  const facts = extractPostingFacts(description);

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
  const outcomes = routesToScreen(facts.route).map((route) => {
    const profile = gateProfile(route);
    const salary = screenSalaryFacts(facts.salary, { route });
    const gates: Gate[] = [
      profile.sponsorRequired
        ? sponsorGate(match, stale)
        : { gate: "Basis", status: "pass" as ScreenStatus, evidence: profile.basis },
      { gate: profile.salaryFloorApplies ? "Salary" : "Rate", ...salary },
      { gate: "Language", ...language },
    ];
    return { route, verdict: combineVerdict(gates) };
  });

  const chosen = bestOutcome(outcomes);

  // Derived here rather than taken from the caller, for the same reason the
  // gates are: `screen_job` and `ingest_jobs` must classify identically, and a
  // caller-supplied track would drift silently between the two paths.
  const track = classifyTrack(title) ?? UNCLASSIFIED_TRACK;

  try {
    await recordScreenedApplication({
      tenant_id: "turicks",
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
      stage: "screened",
      description: description.slice(0, DESCRIPTION_MAX),
      posted_at: input.postedAt ?? null,
      source: input.source ?? "manual",
      external_id: input.externalId ?? null,
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
      await recordSignals(signalsForPosting(description, company), { track });
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

/** Render a screening outcome for the founder. Pure — no I/O, no state. */
export function formatScreenOutcome(
  outcome: Extract<ScreenOutcome, { kind: "duplicate" | "screened" }>,
): string {
  if (outcome.kind === "duplicate") {
    const applied = outcome.appliedAt
      ? ` (applied ${outcome.appliedAt.toISOString().slice(0, 10)})`
      : "";
    return (
      `ALREADY IN PIPELINE — ${outcome.company} · ${outcome.title}\n` +
      `Stage: ${outcome.stage}${applied}\n` +
      `Do not apply again. Follow up on the existing application instead.`
    );
  }

  const { company, title, route, verdict, routesTried, match, nearDuplicates } = outcome;
  const routeLabel = gateProfile(route).label;
  const header =
    verdict.status === "reject"
      ? `REJECT — ${company} · ${title}\nDo not apply. Reasons below are legal bars, not preferences. (Best of ${routesTried} route(s); shown: ${routeLabel}.)`
      : verdict.status === "flag"
        ? `NEEDS A HUMAN CHECK — ${company} · ${title}\nOne or more gates could not be settled from the posting alone. (${routeLabel})`
        : `PASS — ${company} · ${title}\nClears every hard gate on the ${routeLabel}. Safe to research and draft.`;

  // When a basis without a sponsor requirement wins, the sponsor position is
  // never mentioned in the winning basis's reasons — so a founder weighing the
  // more secure HSM footing would not learn the employer is not a recognised
  // sponsor. State it explicitly rather than let the good news hide it.
  const sponsorNote =
    !gateProfile(route).sponsorRequired && match.verdict === "not-sponsor"
      ? `\n\nWorth knowing: this employer is absent from the IND recognised-sponsor register, ` +
        `so the HSM route is not open here today without them applying for recognition.`
      : "";

  const candidates =
    match.candidates.length > 0
      ? `\n\nRegister entries to disambiguate:\n${match.candidates.slice(0, 8).map((c) => `  · ${c}`).join("\n")}`
      : "";

  const nearDupeWarning =
    nearDuplicates.length > 0
      ? `\n\n⚠ POSSIBLE RE-POST of a role already in the tracker:\n${nearDuplicates
          .slice(0, 3)
          .map((d) => `  · "${d.title}" (${d.stage})`)
          .join("\n")}\nCheck before applying — the titles differ but the words are the same.`
      : "";

  return `${header}\n\n${verdict.reasons.map((r) => `  · ${r}`).join("\n")}${sponsorNote}${candidates}${nearDupeWarning}`;
}
