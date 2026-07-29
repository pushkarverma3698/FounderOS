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
import { listScreenedApplications } from "../../db/job-queries.js";
import { getSponsorRegister, registerStaleness } from "./sponsor-registry.js";
import { criterionOn } from "./criteria.js";
import type { UnifiedTool, ToolResult } from "../index.js";

const log = childLogger({ module: "tool:review_screened" });

const VALID_VERDICTS = new Set(["pass", "flag", "reject"]);
const VALID_ROUTES = new Set(["hsm", "remote-contract"]);

/** Health of the inputs the gates depend on, checked on every review. */
export function pipelineHealth(now: Date = new Date()): string[] {
  const notes: string[] = [];

  try {
    const stale = registerStaleness(getSponsorRegister().scrapedAt, now);
    notes.push(stale.stale ? `⚠ ${stale.note}` : `✓ ${stale.note}`);
  } catch (err) {
    notes.push(`⚠ Sponsor register unreadable: ${(err as Error).message}`);
  }

  const criterion = criterionOn(now);
  notes.push(
    criterion
      ? `✓ Salary criterion in force: ${criterion.basis} (€${criterion.annualBase}/yr base, €${criterion.hourly}/hr).`
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
        description: "Filter to 'hsm' or 'remote-contract'. Omit for both.",
      },
      limit: { type: "number", description: "How many rows to show (default 25)." },
    },
    required: [],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const verdict = args["verdict"] as string | undefined;
    const route = args["route"] as string | undefined;
    const limit = Math.min(Number(args["limit"] ?? 25) || 25, 100);

    if (verdict && !VALID_VERDICTS.has(verdict)) {
      return { success: false, error: `verdict must be one of: pass, flag, reject (got "${verdict}").` };
    }
    if (route && !VALID_ROUTES.has(route)) {
      return { success: false, error: `route must be one of: hsm, remote-contract (got "${route}").` };
    }

    let rows: Awaited<ReturnType<typeof listScreenedApplications>>;
    let all: Awaited<ReturnType<typeof listScreenedApplications>>;
    try {
      rows = await listScreenedApplications({
        ...(verdict ? { verdict } : {}),
        ...(route ? { route } : {}),
        limit,
      });
      all = await listScreenedApplications({ limit: 500 });
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

    const health = pipelineHealth().map((h) => `  ${h}`).join("\n");

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
