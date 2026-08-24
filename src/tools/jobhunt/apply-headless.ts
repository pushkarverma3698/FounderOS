/**
 * FounderOS — apply_headless orchestration
 * ==========================================
 * Two entry points, matching the two moments in the flow:
 *
 *   previewApplyFlow  — open, scrape, plan, fill, screenshot, close. No
 *                        external action. Called once, by the `/apply N`
 *                        gateway command, before any HITL gate — same trust
 *                        level as `deliver_artifact` sending a PDF: it shows
 *                        the founder something, it does not act on his behalf.
 *
 *   submitApplyFlow    — open, scrape, plan, fill AGAIN (fresh — no browser
 *                        session survives the HITL wait, which can be minutes
 *                        or up to HITL_TTL_MS=24h), then click submit. Called
 *                        by the `submit_application` agent tool, and the
 *                        re-fill happens BEFORE `hitlGate()` — see that tool's
 *                        own comment for why a repeat fill is the safe,
 *                        idempotent shape and a repeat SEND would not be.
 *
 * Both share `runFillPass`, so the plan the founder reviewed in the screenshot
 * and the plan actually executed on submit are the SAME function called twice
 * — never two implementations that could quietly diverge.
 */

import { childLogger } from "../../infra/logger.js";
import { buildFillPlan, type FillAction, type FillPlanSummary, type RowFacts } from "./apply-fill.js";
import {
  detectApplyAts,
  executeFillPlan,
  openApplyPage,
  screenshotForm,
  scrapeFormFields,
  clickSubmitAndVerify,
  type SupportedAts,
  type SubmitOutcome,
  type FillOutcome,
} from "./apply-driver.js";
import type { ApplyProfile } from "./apply-profile.js";

const log = childLogger({ module: "jobhunt:apply-headless" });

/**
 * The summary the founder actually reads, built from VERIFIED outcomes.
 *
 * NOT `summarisePlan` (apply-fill.ts), which counts what the plan intended,
 * not what the browser confirmed. Found live on Greenhouse, 2026-08-24:
 * `.fill()` can report success and then the field silently reverts within
 * 700ms (see `typeValue` in apply-driver.ts) — a plan-based count would have
 * kept claiming "6/18 filled" through that revert. `unanswered` still comes
 * from the plan's own `ask` actions, since those were never attempted at all
 * and have nothing to verify.
 */
function summariseOutcomes(plan: readonly FillAction[], outcomes: readonly FillOutcome[]): FillPlanSummary {
  const filled = outcomes.filter((o) => o.succeeded).length;
  const unanswered = plan.filter((a) => a.kind === "ask").map((a) => a.question);
  return { filled, total: plan.length, unanswered };
}

export type ApplyFlowResult =
  | { readonly ok: false; readonly reason: string; readonly ats?: SupportedAts | null }
  | {
      readonly ok: true;
      readonly ats: SupportedAts;
      readonly summary: FillPlanSummary;
      readonly unansweredQuestions: readonly string[];
    };

async function runFillPass(
  url: string,
  profile: ApplyProfile,
  row: RowFacts,
): Promise<
  | { ok: false; reason: string; ats: SupportedAts | null }
  | { ok: true; ats: SupportedAts; page: import("playwright").Page; close: () => Promise<void>; summary: FillPlanSummary; unansweredQuestions: readonly string[] }
> {
  const ats = detectApplyAts(url);
  if (!ats) {
    return { ok: false, reason: "not one of the five platforms apply_headless supports (Greenhouse, Lever, Ashby, Workable, Recruitee)", ats: null };
  }

  const session = await openApplyPage(url, ats);
  try {
    const fields = await scrapeFormFields(session.page);
    if (fields.length === 0) {
      log.warn({ url, ats }, "Scraped zero fillable fields");
      await session.close();
      return { ok: false, reason: "no fillable fields found on the page — the form may need a click to reveal it, or the page did not load", ats };
    }
    const plan = buildFillPlan(fields, profile, row);
    const outcomes = await executeFillPlan(session.page, plan);
    const summary = summariseOutcomes(plan, outcomes);
    return { ok: true, ats, page: session.page, close: session.close, summary, unansweredQuestions: summary.unanswered };
  } catch (err) {
    await session.close();
    throw err;
  }
}

export interface PreviewResult extends Extract<ApplyFlowResult, { ok: true }> {
  readonly screenshotPng: Buffer;
}

/**
 * Fill the form and screenshot it. No external side effect — same trust class
 * as `deliver_artifact`. Always closes its own browser.
 */
export async function previewApplyFlow(
  url: string,
  profile: ApplyProfile,
  row: RowFacts,
): Promise<PreviewResult | { ok: false; reason: string; ats?: SupportedAts | null }> {
  const pass = await runFillPass(url, profile, row);
  if (!pass.ok) return pass;

  try {
    const screenshotPng = await screenshotForm(pass.page);
    return { ok: true, ats: pass.ats, summary: pass.summary, unansweredQuestions: pass.unansweredQuestions, screenshotPng };
  } finally {
    await pass.close();
  }
}

export interface SubmitResult extends Extract<ApplyFlowResult, { ok: true }> {
  readonly outcome: SubmitOutcome;
}

/**
 * Re-fill fresh and click submit.
 *
 * CALLED ONLY AFTER `hitlGate()` HAS RETURNED APPROVED. The fill pass itself
 * is safe to have already run once (or to run again on interrupt() replay,
 * per `submit_application`'s own comment) — it types values into a form
 * without sending anything. The click below is the one line in this entire
 * feature that is not safe to repeat, which is exactly why it is the only
 * thing gated.
 */
export async function submitApplyFlow(
  url: string,
  profile: ApplyProfile,
  row: RowFacts,
): Promise<SubmitResult | { ok: false; reason: string; ats?: SupportedAts | null }> {
  const pass = await runFillPass(url, profile, row);
  if (!pass.ok) return pass;

  try {
    const outcome = await clickSubmitAndVerify(pass.page);
    log.info({ ats: pass.ats, clicked: outcome.clicked, confirmed: outcome.confirmed }, "Submit attempted");
    return { ok: true, ats: pass.ats, summary: pass.summary, unansweredQuestions: pass.unansweredQuestions, outcome };
  } finally {
    await pass.close();
  }
}
