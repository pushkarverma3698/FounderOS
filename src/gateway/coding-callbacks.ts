/**
 * FounderOS — the buttons under the coding-pipeline cards
 * =======================================================
 * `cp:<action>:<nonce>` callbacks (cards: coding-cards.ts, pending records: pipeline-pending.ts).
 *
 *  - Spec card:     Approve writes the contract record and labels the issue agent:ready; Change sends it back for a
 *                   new brief; Cancel drops the review label.
 *  - Evidence card: Merge / Merge-after-checking squash-merges the exact head the founder was shown, but only after
 *                   canMerge passes again against what GitHub says right now.
 *
 * What a tap acts on is the pending record the nonce names, never the callback data. The record is CLAIMED first (an
 * atomic rename), so a double tap or a second delivery acts once. A failure that says nothing about the founder's
 * decision (GitHub down, GitHub refusing, a label call failing) releases the claim so the card works again; a
 * decision that was made and acted on leaves the claimed file as its trace.
 *
 * Fail closed throughout: flag off, repo off the dispatch allowlist, fingerprint mismatch, no stored contract,
 * a different approved contract, a PR number the contract is not bound to: each refuses and says why.
 * The audit row is written only after GitHub says merged. telegram.ts lists the `cp:` prefix among the decision
 * buttons, so a guest in an allow-listed group is refused before this runs.
 */

import type { Context } from "grammy";
import { childLogger } from "../infra/logger.js";
import { readContractRecord, writeContractRecord, type StoreFs } from "../tools/contract-store.js";
import { assertAllowedRepo } from "../tools/dispatch-repos.js";
import {
  LABEL_READY,
  LABEL_SPEC_REVIEW,
  claimPending,
  pipelineV2Enabled,
  releasePending,
  type PendingMerge,
  type PendingSpec,
} from "../tools/pipeline-pending.js";
import { canMerge, mergeIdempotencyKey } from "../tools/pr-evidence.js";
import { fingerprintOf } from "../tools/spec-gate.js";
import { parseCodingCallback } from "./coding-cards.js";
import { liveBlockedActions, liveCodingDeps } from "./coding-callbacks-live.js";
import { handleBlockedTap, type BlockedActions } from "./blocked-callbacks.js";

export const CODING_CALLBACK_PREFIX = "cp:";
export const SPEC_APPROVED_ACTION = "pipeline_spec_approved";
export const MERGE_ACTION = "pipeline_merge";
const LABEL_NEEDS_BRIEF = "agent:needs-brief";
const TELEGRAM_CHUNK = 3800;

const log = childLogger({ module: "gateway:coding-callbacks" });

/** What GitHub says about one PR right now. baseSha is the tip of the base branch, not where the PR branched. */
export interface PrState {
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly headSha: string;
  readonly baseSha: string;
  readonly baseRef: string;
}

export interface AuditRow {
  readonly action: string;
  readonly key: string;
  readonly payload: Record<string, unknown>;
}

export interface CodingDeps {
  readonly env: Record<string, string | undefined>;
  readonly fs: StoreFs;
  /** The contracts dir: holds both the approved contract records and the pending/ cards. */
  readonly dir: string;
  now(): Date;
  setLabels(repo: string, issue: number, change: { add: readonly string[]; remove: readonly string[] }): Promise<void>;
  comment(repo: string, issue: number, body: string): Promise<void>;
  /** Starts the issue's run now (fos-job socket). Never throws; a failure is returned so the founder is told. */
  startJob(repo: string, issue: number, stage: "spec" | "build"): Promise<{ status: "inert" | "started" } | { status: "failed"; reason: string }>;
  inspectPr(repo: string, pr: number): Promise<PrState>;
  /** Squash-merges pinned to `sha`; returns the merge commit's sha. Throws when GitHub refuses. */
  merge(repo: string, pr: number, sha: string): Promise<string>;
  /** Merges the base branch into the PR branch, pinned to `expectedHead`, so CI reruns on a head that is current. Throws when GitHub refuses. */
  updateBranch(repo: string, pr: number, expectedHead: string): Promise<void>;
  alreadyDone(key: string): Promise<boolean>;
  /** True when a row was written. */
  audit(row: AuditRow): Promise<boolean>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A reason is never cut (CLAUDE.md #26): text over one Telegram message is split, not truncated. */
async function say(ctx: Context, text: string): Promise<void> {
  for (let i = 0; i < text.length; i += TELEGRAM_CHUNK) await ctx.reply(text.slice(i, i + TELEGRAM_CHUNK));
}

const clearButtons = (ctx: Context): Promise<unknown> =>
  // allow-failopen: clearing a spent keyboard is cosmetic; the decision it records is already made.
  ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);

/** Hand the claim back so the founder can tap the same card again. */
async function release(deps: CodingDeps, nonce: string): Promise<void> {
  const r = await releasePending(deps.fs, deps.dir, nonce);
  if (!r.ok) log.error({ nonce, code: r.code, err: r.error }, "Could not release a pending card");
}

async function approve(ctx: Context, deps: CodingDeps, rec: PendingSpec): Promise<void> {
  const label = `${rec.repo}#${rec.issue}`;
  if (fingerprintOf(rec.contract) !== rec.fingerprint) {
    await say(ctx, `⛔ ${label}: the stored contract does not match its fingerprint, so it is not the spec you were shown. Not approving. Relabel the issue agent:spec for a fresh one.`);
    return;
  }
  const existing = await readContractRecord(deps.fs, deps.dir, rec.repo, rec.issue);
  if (existing.ok) {
    if (existing.value.fingerprint !== rec.fingerprint) {
      await say(ctx, `⛔ ${label} already has a different approved contract (fingerprint ${existing.value.fingerprint.slice(0, 12)}). Not overwriting it.`);
      return;
    }
  } else if (existing.code === "not_found") {
    const written = await writeContractRecord(deps.fs, deps.dir, {
      version: 1,
      repo: rec.repo,
      issue: rec.issue,
      contract: rec.contract,
      fingerprint: rec.fingerprint,
      approved_at: deps.now().toISOString(),
      approved_by: "founder",
      spec_commit: rec.spec_commit,
    });
    if (!written.ok) {
      if (written.code === "io") await release(deps, rec.nonce);
      await say(ctx, `⛔ ${label}: could not store the approval (${written.error}). Nothing was approved.${written.code === "io" ? " Tap Approve again." : ""}`);
      return;
    }
  } else {
    await release(deps, rec.nonce);
    await say(ctx, `⚠️ ${label}: could not read the contract store (${existing.error}). Nothing was approved. Tap Approve again.`);
    return;
  }

  try {
    await deps.setLabels(rec.repo, rec.issue, { add: [LABEL_READY], remove: [LABEL_SPEC_REVIEW] });
  } catch (err) {
    await release(deps, rec.nonce);
    await say(ctx, `⚠️ ${label}: your approval is saved, but GitHub would not move the labels (${errText(err)}). Tap Approve again to finish.`);
    return;
  }

  let audited = true;
  try {
    audited = await deps.audit({
      action: SPEC_APPROVED_ACTION,
      key: `${SPEC_APPROVED_ACTION}:${label}:${rec.fingerprint}`,
      payload: { repo: rec.repo, issue: rec.issue, fingerprint: rec.fingerprint, spec_commit: rec.spec_commit, effective_risk: rec.effective_risk },
    });
  } catch (err) {
    audited = false;
    log.error({ label, err: errText(err) }, "Spec approved, but the audit row failed");
  }
  try {
    await deps.comment(rec.repo, rec.issue, `Spec approved by the founder (contract ${rec.fingerprint.slice(0, 12)}, spec commit ${rec.spec_commit.slice(0, 7)}). The build run starts now.`);
  } catch (err) {
    // allow-failopen: the comment is a courtesy trail; the contract record and the label are the approval.
    log.warn({ label, err: errText(err) }, "Spec approved, but the issue comment failed");
  }
  // Approval is done and recorded; the build starts now, or the founder hears here that nothing is running it.
  const started = await deps.startJob(rec.repo, rec.issue, "build");
  const notStarted = started.status === "failed" ? `\n⚠️ The build did not start: ${started.reason}. Check \`systemctl status fos-job.socket\` on the VPS, then re-queue ${label}.` : "";
  await clearButtons(ctx);
  await say(ctx, `✅ ${label}: spec approved (${rec.fingerprint.slice(0, 12)}). Labelled ${LABEL_READY}.${audited ? "" : "\n⚠️ The audit row could not be written; the approval itself is done."}${notStarted}`);
}

async function sendBack(ctx: Context, deps: CodingDeps, rec: PendingSpec, action: "change" | "cancel"): Promise<void> {
  const label = `${rec.repo}#${rec.issue}`;
  const change = action === "change" ? { add: [LABEL_NEEDS_BRIEF], remove: [LABEL_SPEC_REVIEW] } : { add: [], remove: [LABEL_SPEC_REVIEW] };
  try {
    await deps.setLabels(rec.repo, rec.issue, change);
  } catch (err) {
    await release(deps, rec.nonce);
    await say(ctx, `⚠️ ${label}: GitHub would not move the labels (${errText(err)}). Nothing changed. Tap again.`);
    return;
  }
  await clearButtons(ctx);
  await say(
    ctx,
    action === "change"
      ? `✏️ ${label}: sent back (${LABEL_NEEDS_BRIEF}). Edit the issue to say what to change, then label it agent:spec and I will write a new spec.`
      : `🚫 ${label}: cancelled. Nothing was approved or built; the issue is still open. Label it agent:spec to start over.`,
  );
}

async function mergePr(ctx: Context, deps: CodingDeps, rec: PendingMerge, acknowledged: boolean): Promise<void> {
  const label = `${rec.repo}#${rec.pr}`;
  const stored = await readContractRecord(deps.fs, deps.dir, rec.repo, rec.issue);
  if (!stored.ok) {
    if (stored.code === "io") await release(deps, rec.nonce);
    await say(ctx, `⛔ ${label}: no approved contract for issue #${rec.issue} (${stored.error}). Not merging.`);
    return;
  }
  if (stored.value.pr !== undefined && stored.value.pr !== rec.pr) {
    await say(ctx, `⛔ ${label}: the approved contract for issue #${rec.issue} is bound to PR #${stored.value.pr}, not #${rec.pr}. Not merging.`);
    return;
  }

  let facts: PrState;
  try {
    facts = await deps.inspectPr(rec.repo, rec.pr);
  } catch (err) {
    await release(deps, rec.nonce);
    await say(ctx, `⚠️ Could not read ${label} on GitHub (${errText(err)}). Nothing was merged. Tap again in a minute.`);
    return;
  }
  if (facts.merged) {
    await clearButtons(ctx);
    await say(ctx, `ℹ️ ${label} is already merged. Nothing to do.`);
    return;
  }
  if (facts.state !== "open") {
    await clearButtons(ctx);
    await say(ctx, `⛔ ${label} was closed without merging. Not merging.`);
    return;
  }

  const decision = canMerge({
    evidence: rec.evidence,
    review: rec.review,
    headAtReview: rec.head_at_review,
    headNow: facts.headSha,
    baseAtReview: rec.base_at_review,
    baseNow: facts.baseSha,
  });
  if (!decision.ok) {
    const reasons = decision.reasons.map((r) => `• ${r}`).join("\n");
    // Only the base moved: the review and the evidence still describe this head. The base requires an up-to-date branch,
    // and the review sweep skips a head it already gated, so nothing else would ever produce a new head and a new card.
    const onlyBaseMoved = canMerge({
      evidence: rec.evidence,
      review: rec.review,
      headAtReview: rec.head_at_review,
      headNow: facts.headSha,
      baseAtReview: rec.base_at_review,
      baseNow: rec.base_at_review,
    }).ok;
    if (!onlyBaseMoved) {
      await clearButtons(ctx);
      await say(ctx, `⛔ ${label}: not merging.\n${reasons}\nA fresh evidence card follows when the new head has been checked.`);
      return;
    }
    try {
      await deps.updateBranch(rec.repo, rec.pr, facts.headSha);
    } catch (err) {
      await release(deps, rec.nonce);
      await say(ctx, `⛔ ${label}: not merging.\n${reasons}\nThe PR branch was not updated either: ${errText(err)}\nNothing was merged. Fix that, then tap again.`);
      return;
    }
    await clearButtons(ctx);
    await say(
      ctx,
      `⛔ ${label}: not merging.\n${reasons}\nI merged the new ${facts.baseRef} into the PR branch, so its checks rerun on a current head. ` +
        `A fresh card follows from the next review sweep once those checks finish; if the review sweep is switched off, none comes until it is on again.`,
    );
    return;
  }

  const key = mergeIdempotencyKey(rec.repo, rec.pr, facts.headSha);
  if (await deps.alreadyDone(key)) {
    await clearButtons(ctx);
    await say(ctx, `ℹ️ ${label} at ${facts.headSha.slice(0, 7)} was already merged (audit row ${key} exists). Nothing to do.`);
    return;
  }

  let mergeSha: string;
  try {
    mergeSha = await deps.merge(rec.repo, rec.pr, facts.headSha);
  } catch (err) {
    log.warn({ label, err: errText(err) }, "Merge: GitHub refused");
    await release(deps, rec.nonce);
    await say(ctx, `⛔ GitHub refused to merge ${label}: ${errText(err)}\nNothing was merged. Tap again once that is fixed.`);
    return;
  }

  let audited = true;
  try {
    audited = await deps.audit({
      action: MERGE_ACTION,
      key,
      payload: {
        repo: rec.repo,
        issue: rec.issue,
        pr: rec.pr,
        head: facts.headSha,
        base: facts.baseRef,
        merge_sha: mergeSha,
        acknowledged_unverified: acknowledged,
      },
    });
  } catch (err) {
    audited = false;
    log.error({ label, err: errText(err) }, "Merged, but the audit row failed");
  }

  let traced = true;
  let traceNote = "";
  if (!/^[0-9a-f]{40}$/.test(mergeSha)) {
    traced = false;
    traceNote = `GitHub returned "${mergeSha}" as the merge commit`;
  } else {
    const w = await writeContractRecord(deps.fs, deps.dir, { ...stored.value, pr: rec.pr, merged_sha: mergeSha });
    if (!w.ok) {
      traced = false;
      traceNote = w.error;
    }
  }
  log.info({ label, head: facts.headSha, base: facts.baseRef, mergeSha }, "Coding pipeline: merged");
  await clearButtons(ctx);
  const deploy = facts.baseRef === "main" ? " It deploys on merge." : "";
  await say(
    ctx,
    `✅ Merged ${label} into ${facts.baseRef}.${deploy}` +
      (audited ? "" : "\n⚠️ The audit row could not be written; the merge itself is done.") +
      (traced ? "" : `\n⚠️ The merge is done, but I could not record it for the post-deploy oracle (${traceNote}), so that check will not run.`),
  );
}

/** False when the payload is not ours, so the next callback handler gets it. */
export async function handleCodingCallback(
  ctx: Context,
  deps: CodingDeps = liveCodingDeps(),
  blocked: BlockedActions = liveBlockedActions(),
): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (!data.startsWith(CODING_CALLBACK_PREFIX)) return false;

  const cb = parseCodingCallback(data);
  if (!cb) {
    await ctx.answerCallbackQuery({ text: "That button is out of date." });
    return true;
  }
  // pr-brain's blocked-PR card works with the pipeline flag off too (blocked-callbacks.ts).
  if (cb.action === "fix" || cb.action === "close_pr") {
    await handleBlockedTap(ctx, cb, deps, blocked);
    return true;
  }
  if (!pipelineV2Enabled(deps.env)) {
    await ctx.answerCallbackQuery({ text: "The coding pipeline is switched off." });
    await say(ctx, "⛔ The coding pipeline is switched off (AGENT_PIPELINE_V2 is not 1), so this button did nothing. The card is still valid once it is on.");
    return true;
  }

  const claimed = await claimPending(deps.fs, deps.dir, cb.nonce);
  if (!claimed.ok) {
    await ctx.answerCallbackQuery({ text: claimed.code === "not_found" ? "Already used, or expired." : "Could not read that card." });
    if (claimed.code === "not_found") await say(ctx, "ℹ️ That card was already used or has expired. Nothing was changed.");
    else await say(ctx, `⛔ Could not open that card (${claimed.error}). Nothing was changed.`);
    return true;
  }
  const rec = claimed.value;

  try {
    assertAllowedRepo(rec.repo);
  } catch (err) {
    await ctx.answerCallbackQuery({ text: "Not a repository I act on." });
    await say(ctx, `⛔ ${errText(err)}\nNothing was changed.`);
    return true;
  }

  const wantsSpec = cb.action === "approve" || cb.action === "change" || cb.action === "cancel";
  if (wantsSpec && rec.kind !== "spec") {
    await release(deps, cb.nonce);
    await ctx.answerCallbackQuery({ text: "Wrong card." });
    await say(ctx, "⛔ That button is for a spec card, but its record is not a spec. Nothing was changed.");
    return true;
  }
  if (!wantsSpec && rec.kind !== "merge") {
    await release(deps, cb.nonce);
    await ctx.answerCallbackQuery({ text: "Wrong card." });
    await say(ctx, "⛔ That button is for a merge card, but its record is not a merge. Nothing was changed.");
    return true;
  }

  await ctx.answerCallbackQuery({ text: cb.action === "approve" ? "Approving…" : cb.action.startsWith("merge") ? "Merging…" : "Done." });
  try {
    if (rec.kind === "spec") {
      if (cb.action === "approve") await approve(ctx, deps, rec);
      else await sendBack(ctx, deps, rec, cb.action === "change" ? "change" : "cancel");
    } else if (rec.kind === "merge") {
      await mergePr(ctx, deps, rec, cb.action === "merge_ack");
    }
  } catch (err) {
    // Anything unforeseen: the claim is handed back only if no side effect can have happened; we cannot know, so say so.
    log.error({ nonce: cb.nonce, action: cb.action, err: errText(err) }, "Coding callback failed unexpectedly");
    await say(ctx, `⚠️ Something unexpected stopped that tap (${errText(err)}). Check the issue and PR on GitHub before tapping again; the card was NOT released.`);
  }
  return true;
}
