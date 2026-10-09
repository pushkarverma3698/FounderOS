/**
 * The founder's "fix it" on a PR pr-brain blocked: start the fix now, on the PR's own branch, with every blocker.
 * ==============================================================================================================
 * Oplify issue #115 / PR #116, 2026-10-09: pr-brain blocked the PR with two blockers. The founder said "dispatch agy to
 * fix the issues in the same branch". The requeue tool refused ("already in progress, a second run would race the
 * first"), the bot repeated that as "already working", and nothing was running. The fix waited for the next cron tick.
 *
 * A blocked, reviewed PR is not in progress. It is waiting for a decision, and the founder just made it. One card lists
 * the blockers; on approval the bot hands `{repo, issue, stage: fix, head}` to the job socket. `deploy/agent-dispatch`
 * runs it under the same lock as the cron, so the two never fix one PR at once, and refuses a head that moved since the
 * card was drawn.
 *
 * The pure half (what is fixable, what to say when it is not) is separate from the half that writes, so each is tested.
 */

import type { TaskFacts, TaskPr } from "../../tools/antigravity-status.js";
import { startFailureNote, startFixJob } from "../../tools/dispatch-tick.js";
import { blockerLines, blockersOf } from "../../tools/pr-verdict-facts.js";
import type { ReviewFinding } from "../../tools/review-verdict.js";
import { REVIEWER } from "../../tools/dispatch-roles.js";
import { NO_ACTION_PREFIX } from "../tool-result.js";
import { hitlGate, idemKey } from "./hitl.js";
import { hasBeenAudited, writeAuditEntry } from "../../db/queries.js";
import { TENANT } from "../../core/config.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "agent-tools:blocked-pr-fix" });

/** deploy/agent-dispatch releases a claim after AGENT_DISPATCH_LEASE_MIN (60); an older claim is a dead label, not a run. */
export const WORKING_LEASE_MIN = 60;

const CLAIM = /<!-- agent-claimed: (\S+)/;

export interface BlockedPrFix {
  readonly pr: TaskPr;
  readonly branch: string;
  readonly blockers: readonly ReviewFinding[];
}

/** The PR to fix: open, a draft, with a verdict for its CURRENT head that asks for changes and names a blocker. */
export function blockedPrFix(facts: TaskFacts): BlockedPrFix | null {
  const pr = facts.pr;
  if (!pr || pr.merged || pr.state !== "open" || !pr.draft || !pr.headRef) return null;
  if (pr.verdict?.decision !== "REQUEST_CHANGES") return null;
  const blockers = blockersOf(pr.verdict);
  return blockers.length > 0 ? { pr, branch: pr.headRef, blockers } : null;
}

/** Minutes since the dispatcher claimed the issue, or null when no claim is on it. */
export function claimAgeMinutes(facts: TaskFacts, now: Date): number | null {
  const claim = [...facts.comments].reverse().map((c) => c.body.match(CLAIM)?.[1]).find(Boolean);
  const at = claim ? Date.parse(claim) : Number.NaN;
  return Number.isFinite(at) ? Math.max(0, Math.floor((now.getTime() - at) / 60_000)) : null;
}

const sameCommit = (a: string, b: string): boolean => a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

/**
 * Why a PR that is not fixable (see blockedPrFix) is not: what the founder is waiting for, said as it is.
 * Null when the PR does not explain it (no open PR).
 */
export function openPrWaitReason(facts: TaskFacts): string | null {
  const pr = facts.pr;
  if (!pr || pr.merged || pr.state !== "open") return null;
  const reviewed = pr.verdict != null || pr.reviewedHeads.some((h) => sameCommit(h.toLowerCase(), pr.headSha.toLowerCase()));
  if (!reviewed) {
    return `PR #${pr.number} is open and ${REVIEWER} has not finished reviewing its latest commit (it runs every 20 min). There is nothing to fix yet; the verdict arrives in Telegram when the review is done.`;
  }
  if (!pr.draft) return `PR #${pr.number} was reviewed and cleared (ready to merge). There is nothing to fix; merging it is your call.`;
  const decision = pr.verdict?.decision;
  if (decision === "APPROVE") return `${REVIEWER} approved PR #${pr.number}'s current commit. There is nothing to fix.`;
  return (
    `${REVIEWER} reviewed PR #${pr.number} but its verdict has no blocker to hand to a fixer (decision: ${decision ?? "unreadable"}). ` +
    `Read the verdict on the PR before deciding: ${pr.url}`
  );
}

const plural = (n: number): string => `${n} blocker${n === 1 ? "" : "s"}`;

/** One decision per head: the chat tool and the Fix now button on pr-brain's card share it, so the two never both start a fix. */
export const fixBlockedPrKey = (slug: string, issue: number, head: string): string => idemKey("fix_blocked_pr", slug.toLowerCase(), String(issue), head.toLowerCase());

export interface FixRequest {
  readonly slug: string;
  readonly issueNumber: number;
  readonly repoArg: string | null | undefined;
  readonly founderRequest: string | null | undefined;
  readonly action: "dispatch_antigravity_task" | "requeue_antigravity_task";
}

type GateConfig = Parameters<typeof hitlGate>[1];

/** One card with the blockers, then the fix job. Writes nothing to GitHub: the job owns labels and the attempt comment. */
export async function fixBlockedPr(fix: BlockedPrFix, req: FixRequest, facts: TaskFacts, status: string, config: GateConfig): Promise<string> {
  const { pr, branch, blockers } = fix;
  const n = req.issueNumber;
  const short = pr.headSha.slice(0, 7);

  // Bound to the head the founder saw: a new commit is a new decision, and a replayed approval starts nothing twice.
  const key = fixBlockedPrKey(req.slug, n, pr.headSha);
  if (await hasBeenAudited(key)) {
    return `${NO_ACTION_PREFIX} The fix for ${req.slug}#${n} at ${short} was already started from an earlier approval.\n\n${status}`;
  }

  const card = {
    title: `🔧 Fix PR #${pr.number} now? ${plural(blockers.length)} from ${REVIEWER}`,
    summary:
      `Same branch, nothing new filed: ${req.slug}#${n} → PR #${pr.number} on ${branch} at ${short}. ` +
      `Antigravity gets every blocker below and fixes them on that branch now (fix round ${pr.attempts + 1}); ${REVIEWER} re-reviews the new commit.`,
    preview: [`Branch ${branch}, merges into ${pr.baseRef}`, ...blockerLines(pr.verdict), pr.url].join("\n"),
    args: { issue: n, repo: req.repoArg ?? null, founder_request: req.founderRequest ?? null, head: pr.headSha },
  };
  // One literal action per tool: tests/unit/agents/capabilities.test.ts proves every gated tool has a real gate.
  const rejected = req.action === "requeue_antigravity_task"
    ? await hitlGate({ action: "requeue_antigravity_task", ...card }, config)
    : await hitlGate({ action: "dispatch_antigravity_task", ...card }, config);
  if (rejected) return rejected;

  const started = await startFixJob(n, req.slug, pr.headSha);
  if (started.status === "failed") return `⚠️ ${startFailureNote(n, req.slug, started.reason)}\n${pr.url}`;
  if (started.status === "inert") {
    return `Nothing was started: this host does not run jobs (AGENT_DISPATCH_BIN is unset), so the fix for PR #${pr.number} was not handed to anything.\n${pr.url}`;
  }

  const auditRes = await writeAuditEntry({
    action: req.action,
    idempotency_key: key,
    payload: { issue_number: n, repo: req.slug, pr: pr.number, head: pr.headSha, branch, blockers: blockers.length },
    tenant_id: TENANT,
  });
  if (!auditRes.written) log.warn({ key }, `writeAuditEntry conflict on ${req.action}`);

  const quota = facts.quotaUntil && facts.quotaUntil > new Date()
    ? `\nAntigravity's quota is exhausted until ${facts.quotaUntil.toISOString().slice(0, 16).replace("T", " ")} UTC, so the run may not start before then.`
    : "";
  return (
    `✅ Fix started now on branch ${branch} (PR #${pr.number}) for ${plural(blockers.length)}. It does not wait for the next cron run; ` +
    `if another run holds the dispatch lock it starts right after it. ${REVIEWER} re-reviews the new commit within about 20 min of the push, ` +
    `and you get the card here.${quota}\n${pr.url}`
  );
}
