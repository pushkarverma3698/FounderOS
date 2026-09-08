/**
 * FounderOS — review_screened tool
 * ================================
 * Reads screening outcomes back out of the tracker.
 *
 * This is the observability half of the gates, and it is not optional. Every
 * other failure in this pipeline is loud — a wasted application produces a
 * rejection email. A gate that wrongly REJECTS is silent by construction: the
 * role never enters the queue, so nothing ever signals that it existed.
 *
 * A stale register, a regex that stops matching, or a criterion that lapsed on
 * 1 January all present the same way: the reject rate moves and nobody notices.
 * So the tool leads with the reject rate rather than burying it under listings.
 */

import { childLogger } from "../../infra/logger.js";
import { listScreenedApplications, type ProfileScope } from "../../db/job-queries.js";
import { getSponsorRegister, registerStaleness } from "./sponsor-registry.js";
import { criterionOn } from "./criteria.js";
import { KNOWN_PERMIT_BASES } from "./permit-routes.js";
import { getProfile, type JobSearchProfile } from "./profile-config.js";
import type { UnifiedTool, ToolResult } from "../index.js";

const log = childLogger({ module: "tool:review_screened" });

const VALID_VERDICTS = new Set(["pass", "flag", "reject"]);

/**
 * Every basis the screener can record, DERIVED rather than written down again.
 *
 * It was the literal `["hsm", "remote-contract"]` until 2026-09-08, which is two
 * of five: `zoekjaar`, `partner-permit` and `india-local` were rejected with
 * "route must be one of: hsm, remote-contract". Measured on prod that day, 97 of
 * 1,705 rows (5.7%) could be filtered at all — the second candidate's primary
 * basis could not be queried, and neither could the 1,144 India rows that are the
 * largest single group in the table. A hardcoded copy of a union that lives one
 * import away is a list that stops being true the day the union grows, and this
 * one had.
 */
const VALID_ROUTES: ReadonlySet<string> = new Set(KNOWN_PERMIT_BASES);

/**
 * Health of the inputs the gates depend on, checked on every review.
 *
 * TAKES THE PROFILE, since 2026-09-08. `criterionOn(now)` with no arguments falls
 * back to the module default `FOUNDER_DOB`, so reviewing the second candidate's
 * queue printed "IND 2026 under-30 criterion, €4357/month" above a list of rows
 * every one of which had been screened against the €3,122 reduced criterion. The
 * one tool whose stated job is to catch a criterion that lapsed was reporting a
 * criterion that did not apply.
 */
export function pipelineHealth(
  now: Date = new Date(),
  profile: JobSearchProfile = getProfile(),
): string[] {
  const notes: string[] = [];

  try {
    const stale = registerStaleness(getSponsorRegister().scrapedAt, now);
    notes.push(stale.stale ? `⚠ ${stale.note}` : `✓ ${stale.note}`);
  } catch (err) {
    notes.push(`⚠ Sponsor register unreadable: ${(err as Error).message}`);
  }

  const criterion = criterionOn(now, profile.dob, profile.reducedCriterionUntil ?? null);
  notes.push(
    criterion
      ? `✓ Salary criterion in force for ${profile.candidateName}: ${criterion.basis} (€${criterion.annualBase}/yr base, €${criterion.hourly}/hr).`
      : `⚠ No verified salary criterion for ${now.toISOString().slice(0, 10)} — every salary verdict is currently a flag. Add the new window to criteria.ts.`,
  );

  return notes;
}

export const reviewScreenedTool: UnifiedTool = {
  name: "review_screened",
  description:
    "Review what the screening gates have been deciding: reject/flag/pass counts, the " +
    "most recent screenings with their reasons, and the health of the register and salary " +
    "criterion the gates depend on. Use this to audit the pipeline — a gate that wrongly " +
    "rejects is otherwise invisible. Read-only, no approval needed.",
  input_schema: {
    type: "object",
    properties: {
      verdict: {
        type: "string",
        description: "Filter to one outcome: 'pass', 'flag' or 'reject'. Omit for all.",
      },
      route: {
        type: "string",
        description:
          "Filter to one permit basis: hsm, partner-permit, remote-contract, india-local or " +
          "zoekjaar. Omit for all.",
      },
      limit: { type: "number", description: "How many rows to show (default 25)." },
      profileId: {
        type: "string",
        description:
          "Which candidate's queue to review — a registered profile id (e.g. wife-nl-finance), " +
          "already resolved from free text by the caller. Omit for the founder's own queue, " +
          "never a mix of every candidate's rows.",
      },
    },
    required: [],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const verdict = args["verdict"] as string | undefined;
    const route = args["route"] as string | undefined;
    const limit = Math.min(Number(args["limit"] ?? 25) || 25, 100);
    const profileId = args["profileId"] as ProfileScope | undefined;

    if (verdict && !VALID_VERDICTS.has(verdict)) {
      return { success: false, error: `verdict must be one of: pass, flag, reject (got "${verdict}").` };
    }
    if (route && !VALID_ROUTES.has(route)) {
      return {
        success: false,
        error: `route must be one of: ${KNOWN_PERMIT_BASES.join(", ")} (got "${route}").`,
      };
    }

    let rows: Awaited<ReturnType<typeof listScreenedApplications>>;
    let all: Awaited<ReturnType<typeof listScreenedApplications>>;
    try {
      rows = await listScreenedApplications({
        ...(verdict ? { verdict } : {}),
        ...(route ? { route } : {}),
        limit,
        profileId,
      });
      all = await listScreenedApplications({ limit: 500, profileId });
    } catch (err) {
      return { success: false, error: `Application tracker unreachable: ${(err as Error).message}` };
    }

    const counts = { pass: 0, flag: 0, reject: 0, other: 0 };
    for (const r of all) {
      if (r.salary_status === "pass") counts.pass++;
      else if (r.salary_status === "flag") counts.flag++;
      else if (r.salary_status === "reject") counts.reject++;
      else counts.other++;
    }
    const total = all.length;
    const pct = (n: number) => (total === 0 ? "0%" : `${Math.round((n / total) * 100)}%`);

    // Scoped to the queue being reviewed. An unscoped health line above a scoped
    // listing is the tool contradicting its own data. ALL_PROFILES is a symbol,
    // not a profile id, so it falls back to the default rather than throwing —
    // there is no single criterion to state across a mixed queue anyway.
    const reviewed = typeof profileId === "string" ? getProfile(profileId) : getProfile();
    const health = pipelineHealth(new Date(), reviewed).map((h) => `  ${h}`).join("\n");

    if (total === 0) {
      return {
        success: true,
        data: `No postings screened yet.\n\nPipeline health:\n${health}`,
      };
    }

    const listing =
      rows.length === 0
        ? "  (none matching that filter)"
        : rows
            .map((r) => {
              const when = r.created_at ? r.created_at.toISOString().slice(0, 10) : "?";
              const why = (r.salary_evidence ?? "").slice(0, 200);
              return `  [${r.salary_status.toUpperCase()}] ${r.company} · ${r.title} (${r.route}, ${when})\n      ${why}`;
            })
            .join("\n");

    log.info({ total, counts, verdict, route }, "Screening review");

    return {
      success: true,
      data:
        `Screening review — ${total} posting(s) on record\n` +
        `  pass ${counts.pass} (${pct(counts.pass)}) · flag ${counts.flag} (${pct(counts.flag)}) · reject ${counts.reject} (${pct(counts.reject)})\n\n` +
        `Pipeline health:\n${health}\n\n` +
        `Most recent${verdict ? ` ${verdict}` : ""}${route ? ` on ${route}` : ""}:\n${listing}`,
    };
  },
};
