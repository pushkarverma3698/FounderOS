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
 * Two routes are screened, because the campaign's highest-EV channel is a remote
 * contract that needs no sponsor and has no legal floor. Applying the HSM gates
 * to it would reject exactly the opportunities worth most.
 */

import { childLogger } from "../../infra/logger.js";
import { matchSponsor, type SponsorMatch } from "./sponsor-match.js";
import { getSponsorRegister, registerStaleness } from "./sponsor-registry.js";
import { extractPostingFacts, type PostingRoute } from "./extract.js";
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
  if (route === "hsm") return ["hsm"];
  if (route === "remote-contract") return ["remote-contract"];
  return ["hsm", "remote-contract"];
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
  const status: ScreenStatus =
    match.verdict === "sponsor" ? "pass" : match.verdict === "not-sponsor" ? "reject" : "flag";
  return { gate: "Sponsor", status, evidence: match.evidence };
}

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
    const company = String(args["company"] ?? "").trim();
    const title = String(args["title"] ?? "").trim();
    if (company.length === 0 || title.length === 0) {
      return { success: false, error: "screen_job needs both a company and a title." };
    }

    const url = args["url"] as string | undefined;
    const description = String(args["description"] ?? "");
    const key = dedupeKey(company, title);
    const softKey = softDedupeKey(company, title);

    // Duplicate check first — cheapest gate, most embarrassing failure.
    let existing: Awaited<ReturnType<typeof findApplicationByDedupeKey>> = null;
    let nearDuplicates: Awaited<ReturnType<typeof findApplicationsBySoftKey>> = [];
    try {
      existing = await findApplicationByDedupeKey(key);
      nearDuplicates = await findApplicationsBySoftKey(softKey, key);
    } catch (err) {
      return { success: false, error: `Application tracker unreachable: ${(err as Error).message}` };
    }

    if (
      existing &&
      ENGAGED_STAGES.has(existing.stage) &&
      !isStaleEnoughToReapply(existing.applied_at ?? null, new Date())
    ) {
      return {
        success: true,
        data:
          `ALREADY IN PIPELINE — ${company} · ${title}\n` +
          `Stage: ${existing.stage}${existing.applied_at ? ` (applied ${existing.applied_at.toISOString().slice(0, 10)})` : ""}\n` +
          `Do not apply again. Follow up on the existing application instead.`,
      };
    }

    const facts = extractPostingFacts(description);

    let register: ReturnType<typeof getSponsorRegister>;
    try {
      register = getSponsorRegister();
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
    const stale = registerStaleness(register.scrapedAt);
    const match = matchSponsor(company, register.index);
    const language = screenLanguage(description);

    const outcomes = routesToScreen(facts.route).map((route) => {
      const salary = screenSalaryFacts(facts.salary, { route });
      const gates: Gate[] =
        route === "hsm"
          ? [sponsorGate(match, stale), { gate: "Salary", ...salary }, { gate: "Language", ...language }]
          : [
              { gate: "Route", status: "pass" as ScreenStatus, evidence: "Remote contract — no sponsor or permit floor applies." },
              { gate: "Rate", ...salary },
              { gate: "Language", ...language },
            ];
      return { route, verdict: combineVerdict(gates) };
    });

    const chosen = bestOutcome(outcomes);

    try {
      await recordScreenedApplication({
        tenant_id: "turicks",
        dedupe_key: key,
        soft_dedupe_key: softKey,
        company,
        registered_name: match.registered_name ?? null,
        title,
        url: url ?? null,
        route: chosen.route,
        sponsor_verdict: match.verdict,
        salary_status: chosen.verdict.status,
        salary_evidence: chosen.verdict.reasons.join(" | ").slice(0, 2000),
        stage: "screened",
      });
    } catch (err) {
      return {
        success: false,
        error: `Screened "${company} · ${title}" but could not record it: ${(err as Error).message}`,
      };
    }

    log.info(
      { company, title, route: chosen.route, verdict: chosen.verdict.status, detectedRoute: facts.route },
      "Job screened",
    );

    const routeLabel = chosen.route === "hsm" ? "sponsorship route" : "remote-contract route";
    const header =
      chosen.verdict.status === "reject"
        ? `REJECT — ${company} · ${title}\nDo not apply. Reasons below are legal bars, not preferences. (Best of ${outcomes.length} route(s); shown: ${routeLabel}.)`
        : chosen.verdict.status === "flag"
          ? `NEEDS A HUMAN CHECK — ${company} · ${title}\nOne or more gates could not be settled from the posting alone. (${routeLabel})`
          : `PASS — ${company} · ${title}\nClears every hard gate on the ${routeLabel}. Safe to research and draft.`;

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

    return {
      success: true,
      data: `${header}\n\n${chosen.verdict.reasons.map((r) => `  · ${r}`).join("\n")}${candidates}${nearDupeWarning}`,
    };
  },
};
