/**
 * FounderOS — screen_job tool
 * ===========================
 * The gate the whole NL entry campaign hangs off
 * (docs/strategy/09-NL-ENTRY-CAMPAIGN.md §3). It applies the deterministic
 * filters to one posting BEFORE any model spend or founder attention, and
 * records the verdict in `job_applications`.
 *
 * Every gate here is pure code, deliberately. The sponsor register and the
 * salary criterion are LEGAL facts, not judgements — a model asked to apply them
 * would occasionally get them wrong, and each wrong answer costs either a whole
 * wasted application or a silently discarded real opportunity.
 *
 * The verdict is three-way for the same reason the sponsor match is: `reject`
 * only where the hire is legally impossible, `flag` wherever the evidence is
 * merely absent. Most Dutch postings state no salary, so treating silence as
 * rejection would discard the majority of the reachable market.
 */

import { childLogger } from "../../infra/logger.js";
import { matchSponsor } from "./sponsor-match.js";
import { getSponsorIndex } from "./sponsor-registry.js";
import {
  dedupeKey,
  isStaleEnoughToReapply,
  screenLanguage,
  screenSalary,
  type ScreenStatus,
} from "./filters.js";
import {
  findApplicationByDedupeKey,
  recordScreenedApplication,
} from "../../db/job-queries.js";
import type { UnifiedTool, ToolResult } from "../index.js";

const log = childLogger({ module: "tool:screen_job" });

/** Stages that mean the founder has already engaged — never silently re-screen over them. */
const ENGAGED_STAGES = new Set(["drafted", "awaiting_approval", "applied", "replied"]);

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
export function combineVerdict(
  gates: ReadonlyArray<{ gate: string; status: ScreenStatus; evidence: string }>,
): ScreenVerdict {
  const reasons = gates.map((g) => `${g.gate}: ${g.evidence}`);
  if (gates.some((g) => g.status === "reject")) return { status: "reject", reasons };
  if (gates.some((g) => g.status === "flag")) return { status: "flag", reasons };
  return { status: "pass", reasons };
}

export const screenJobTool: UnifiedTool = {
  name: "screen_job",
  description:
    "Screen ONE job posting against the hard gates before drafting anything: IND " +
    "recognised-sponsor register, the under-30 highly skilled migrant salary floor, " +
    "Dutch-language requirement, and duplicate-application check. Records the verdict " +
    "in the application tracker. Read-mostly, no approval needed. Call this before " +
    "writing any cover letter — a posting that fails these gates cannot legally hire.",
  input_schema: {
    type: "object",
    properties: {
      company: { type: "string", description: "Employer name exactly as it appears on the posting." },
      title: { type: "string", description: "Role title, e.g. 'Senior AI Engineer'." },
      url: { type: "string", description: "Link to the posting." },
      description: {
        type: "string",
        description: "Posting text — used for the Dutch-language requirement check.",
      },
      salary_min: { type: "number", description: "Advertised annual base minimum in EUR, if stated." },
      salary_max: { type: "number", description: "Advertised annual base maximum in EUR, if stated." },
    },
    required: ["company", "title"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const company = String(args["company"] ?? "").trim();
    const title = String(args["title"] ?? "").trim();
    if (company.length === 0 || title.length === 0) {
      return { success: false, error: "screen_job needs both a company and a title." };
    }

    const url = args["url"] as string | undefined;
    const description = (args["description"] as string | undefined) ?? "";
    const salaryMin = args["salary_min"] as number | undefined;
    const salaryMax = args["salary_max"] as number | undefined;

    const key = dedupeKey(company, title);

    // Duplicate check first — it is the cheapest gate and the most embarrassing
    // failure. A role already in flight is reported, never re-screened over.
    let existing: Awaited<ReturnType<typeof findApplicationByDedupeKey>> = null;
    try {
      existing = await findApplicationByDedupeKey(key);
    } catch (err) {
      return {
        success: false,
        error: `Application tracker unreachable: ${(err as Error).message}`,
      };
    }

    if (existing && ENGAGED_STAGES.has(existing.stage)) {
      if (!isStaleEnoughToReapply(existing.applied_at ?? null, new Date())) {
        return {
          success: true,
          data:
            `ALREADY IN PIPELINE — ${company} · ${title}\n` +
            `Stage: ${existing.stage}${existing.applied_at ? ` (applied ${existing.applied_at.toISOString().slice(0, 10)})` : ""}\n` +
            `Do not apply again. Follow up on the existing application instead.`,
        };
      }
    }

    let sponsor: ReturnType<typeof matchSponsor>;
    try {
      sponsor = matchSponsor(company, getSponsorIndex());
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }

    const sponsorStatus: ScreenStatus =
      sponsor.verdict === "sponsor" ? "pass" : sponsor.verdict === "not-sponsor" ? "reject" : "flag";
    const salary = screenSalary({ min: salaryMin, max: salaryMax });
    const language = screenLanguage(description);

    const verdict = combineVerdict([
      { gate: "Sponsor", status: sponsorStatus, evidence: sponsor.evidence },
      { gate: "Salary", status: salary.status, evidence: salary.evidence },
      { gate: "Language", status: language.status, evidence: language.evidence },
    ]);

    try {
      await recordScreenedApplication({
        tenant_id: "turicks",
        dedupe_key: key,
        company,
        registered_name: sponsor.registered_name ?? null,
        title,
        url: url ?? null,
        sponsor_verdict: sponsor.verdict,
        salary_status: salary.status,
        salary_evidence: salary.evidence,
        stage: "screened",
      });
    } catch (err) {
      return {
        success: false,
        error: `Screened "${company} · ${title}" but could not record it: ${(err as Error).message}`,
      };
    }

    log.info({ company, title, verdict: verdict.status }, "Job screened");

    const header =
      verdict.status === "reject"
        ? `REJECT — ${company} · ${title}\nDo not apply. Reason(s) below are legal bars, not preferences.`
        : verdict.status === "flag"
          ? `NEEDS A HUMAN CHECK — ${company} · ${title}\nOne or more gates could not be settled from the posting alone.`
          : `PASS — ${company} · ${title}\nClears every hard gate. Safe to research and draft.`;

    const candidates =
      sponsor.candidates.length > 0
        ? `\n\nRegister entries to disambiguate:\n${sponsor.candidates.slice(0, 8).map((c) => `  · ${c}`).join("\n")}`
        : "";

    return {
      success: true,
      data: `${header}\n\n${verdict.reasons.map((r) => `  · ${r}`).join("\n")}${candidates}`,
    };
  },
};
