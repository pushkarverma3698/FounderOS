/**
 * FounderOS — the Fix now / Close PR buttons under pr-brain's blocked-PR card
 * ===========================================================================
 * `cp:fix:<nonce>` and `cp:close_pr:<nonce>` (card: blocked-card.ts, written by scripts/blocked-review-card.ts, record:
 * a "fix" pending record in pipeline-pending.ts). They work with the coding-pipeline flag OFF: a PR pr-brain blocked is
 * blocked on every path, and this is the legacy path's only way to act on it from the phone.
 *
 * What a tap acts on is the pending record the nonce names, claimed first (an atomic rename), so a double tap acts once.
 * Both taps re-read GitHub and refuse when the PR has a new commit since the card: a verdict is about one head
 * (CLAUDE.md #35), and a fix or a close decided on the old findings could throw away work that already answered them.
 *
 *  - Fix now:  hands `{repo, issue, stage: fix, head}` to the job socket, the same path as the chat "fix it"
 *              (blocked-pr-fix.ts). The idempotency key is shared with that tool: one decision per head, whichever
 *              door it came through.
 *  - Close PR: closes the PR unmerged with a comment saying who and why. agent-dispatch then takes agent:review off the
 *              issue (its section 1b), and the issue stays open.
 */

import type { Context } from "grammy";
import { fixBlockedPrKey } from "../agents/agent-tools/blocked-pr-fix.js";
import { childLogger } from "../infra/logger.js";
import { assertAllowedRepo } from "../tools/dispatch-repos.js";
import { startFailureNote } from "../tools/dispatch-tick.js";
import { claimPending, releasePending, type PendingFix } from "../tools/pipeline-pending.js";
import type { CodingCallback } from "./coding-cards.js";
import type { CodingDeps, PrState } from "./coding-callbacks.js";

const log = childLogger({ module: "gateway:blocked-callbacks" });

export const FIX_AUDIT_ACTION = "fix_blocked_pr";
export const CLOSE_AUDIT_ACTION = "close_blocked_pr";
const TELEGRAM_CHUNK = 3800;

/** The two side effects, injected so the handler is tested without GitHub or the job socket. */
export interface BlockedActions {
  startFix(repo: string, issue: number, head: string): Promise<{ status: "inert" | "started" } | { status: "failed"; reason: string }>;
  /** Closes the PR unmerged and leaves `note` on it. Throws when GitHub refuses. */
  closePr(repo: string, pr: number, note: string): Promise<void>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const plural = (n: number): string => `${n} blocker${n === 1 ? "" : "s"}`;

async function say(ctx: Context, text: string): Promise<void> {
  for (let i = 0; i < text.length; i += TELEGRAM_CHUNK) await ctx.reply(text.slice(i, i + TELEGRAM_CHUNK));
}

const clearButtons = (ctx: Context): Promise<unknown> =>
  // allow-failopen: clearing a spent keyboard is cosmetic; the decision it records is already made.
  ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);

async function release(deps: CodingDeps, nonce: string): Promise<void> {
  const r = await releasePending(deps.fs, deps.dir, nonce);
  if (!r.ok) log.error({ nonce, code: r.code, err: r.error }, "Could not release a pending card");
}

/** The PR as it stands, or null after telling the founder why nothing was done. */
async function currentPr(ctx: Context, deps: CodingDeps, rec: PendingFix): Promise<PrState | null> {
  const label = `${rec.repo}#${rec.pr}`;
  let facts: PrState;
  try {
    facts = await deps.inspectPr(rec.repo, rec.pr);
  } catch (err) {
    await release(deps, rec.nonce);
    await say(ctx, `⚠️ Could not read ${label} on GitHub (${errText(err)}). Nothing was changed. Tap again in a minute.`);
    return null;
  }
  if (facts.merged) {
    await clearButtons(ctx);
    await say(ctx, `ℹ️ ${label} is already merged. Nothing to do.`);
    return null;
  }
  if (facts.state !== "open") {
    await clearButtons(ctx);
    await say(ctx, `ℹ️ ${label} was closed without merging. Nothing to do.`);
    return null;
  }
  if (facts.headSha.toLowerCase() !== rec.head.toLowerCase()) {
    await clearButtons(ctx);
    await say(
      ctx,
      `⛔ ${label} has a new commit since this card (card: ${rec.head.slice(0, 7)}, now: ${facts.headSha.slice(0, 7)}). ` +
        `Those findings may already be answered, so nothing was changed. The new commit gets its own review and a new card.`,
    );
    return null;
  }
  return facts;
}

async function fixNow(ctx: Context, deps: CodingDeps, acts: BlockedActions, rec: PendingFix): Promise<void> {
  const label = `${rec.repo}#${rec.pr}`;
  if (rec.issue === undefined) {
    await release(deps, rec.nonce);
    await say(ctx, `⛔ ${label} is not linked to an issue (its branch is ${rec.branch}, not task/issue-N), so the pipeline cannot dispatch a fix. Fix it by hand, or close it.`);
    return;
  }
  if (!(await currentPr(ctx, deps, rec))) return;

  const key = fixBlockedPrKey(rec.repo, rec.issue, rec.head);
  if (await deps.alreadyDone(key)) {
    await clearButtons(ctx);
    await say(ctx, `ℹ️ The fix for ${label} at ${rec.head.slice(0, 7)} was already started from an earlier approval. Nothing new was started.`);
    return;
  }

  const started = await acts.startFix(rec.repo, rec.issue, rec.head);
  if (started.status === "failed") {
    await release(deps, rec.nonce);
    await say(ctx, `⚠️ ${startFailureNote(rec.issue, rec.repo, started.reason)}\nThe card still works: tap Fix now again once that is fixed.`);
    return;
  }
  if (started.status === "inert") {
    await release(deps, rec.nonce);
    await say(ctx, `Nothing was started: this host does not run jobs (AGENT_DISPATCH_BIN is unset), so the fix for ${label} was not handed to anything.`);
    return;
  }

  let audited = true;
  try {
    audited = await deps.audit({
      action: FIX_AUDIT_ACTION,
      key,
      payload: { repo: rec.repo, issue: rec.issue, pr: rec.pr, head: rec.head, branch: rec.branch, blockers: rec.blockers, via: "blocked-card" },
    });
  } catch (err) {
    audited = false;
    log.error({ label, err: errText(err) }, "Fix started, but the audit row failed");
  }
  await clearButtons(ctx);
  await say(
    ctx,
    `✅ Fix started now on branch ${rec.branch} (PR ${rec.pr}) for ${plural(rec.blockers)}. It does not wait for the next cron run; ` +
      `if another run holds the dispatch lock it starts right after it. pr-brain re-reviews the new commit within about 20 min of the push, and you get a new card here.` +
      (audited ? "" : "\n⚠️ The audit row could not be written; the fix itself is started."),
  );
}

async function closeNow(ctx: Context, deps: CodingDeps, acts: BlockedActions, rec: PendingFix): Promise<void> {
  const label = `${rec.repo}#${rec.pr}`;
  if (!(await currentPr(ctx, deps, rec))) return;
  const note = `Closed by the founder from the pr-brain card in Telegram: ${plural(rec.blockers)} at ${rec.head.slice(0, 7)} were not going to be fixed. Reopen the PR to continue.`;
  try {
    await acts.closePr(rec.repo, rec.pr, note);
  } catch (err) {
    log.warn({ label, err: errText(err) }, "Close PR: GitHub refused");
    await release(deps, rec.nonce);
    await say(ctx, `⛔ GitHub would not close ${label}: ${errText(err)}\nNothing was changed. The card still works.`);
    return;
  }
  try {
    await deps.audit({
      action: CLOSE_AUDIT_ACTION,
      key: `${CLOSE_AUDIT_ACTION}:${rec.repo}:${rec.pr}:${rec.head}`,
      payload: { repo: rec.repo, pr: rec.pr, head: rec.head, blockers: rec.blockers },
    });
  } catch (err) {
    // allow-failopen: the PR is closed and commented; the audit row is the trail, and its absence is logged here.
    log.error({ label, err: errText(err) }, "PR closed, but the audit row failed");
  }
  await clearButtons(ctx);
  await say(ctx, `🚫 Closed PR #${rec.pr} in ${rec.repo} without merging. Reopen it from GitHub if you change your mind. The issue stays open.`);
}

/** Handles cp:fix and cp:close_pr. Never throws: an unforeseen failure leaves the claim and says so. */
export async function handleBlockedTap(ctx: Context, cb: CodingCallback, deps: CodingDeps, acts: BlockedActions): Promise<void> {
  const claimed = await claimPending(deps.fs, deps.dir, cb.nonce);
  if (!claimed.ok) {
    await ctx.answerCallbackQuery({ text: claimed.code === "not_found" ? "Already used, or expired." : "Could not read that card." });
    if (claimed.code === "not_found") await say(ctx, "ℹ️ That card was already used or has expired. Nothing was changed.");
    else await say(ctx, `⛔ Could not open that card (${claimed.error}). Nothing was changed.`);
    return;
  }
  const rec = claimed.value;
  if (rec.kind !== "fix") {
    await release(deps, cb.nonce);
    await ctx.answerCallbackQuery({ text: "Wrong card." });
    await say(ctx, "⛔ That button is for a blocked-PR card, but its record is not one (not a fix record). Nothing was changed.");
    return;
  }
  try {
    assertAllowedRepo(rec.repo);
  } catch (err) {
    await ctx.answerCallbackQuery({ text: "Not a repository I act on." });
    await say(ctx, `⛔ ${errText(err)}\nNothing was changed.`);
    return;
  }
  await ctx.answerCallbackQuery({ text: cb.action === "fix" ? "Starting the fix…" : "Closing…" });
  try {
    if (cb.action === "fix") await fixNow(ctx, deps, acts, rec);
    else await closeNow(ctx, deps, acts, rec);
  } catch (err) {
    log.error({ nonce: cb.nonce, action: cb.action, err: errText(err) }, "Blocked-card tap failed unexpectedly");
    await say(ctx, `⚠️ Something unexpected stopped that tap (${errText(err)}). Check the PR on GitHub before tapping again; the card was NOT released.`);
  }
}
