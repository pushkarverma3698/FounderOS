/**
 * FounderOS — the card for a PR that pr-brain blocked
 * ====================================================
 * Oplify PR #116, 2026-10-09: pr-brain blocked it with two blockers and the founder got "CHANGES REQUESTED — blocked ·
 * <title>", a Merge line and a link. Nothing said what was wrong or what he could do about it, so he typed a request in
 * chat and the bot, with no facts, said it was "already working".
 *
 * This card says what the reviewer found, every blocker with where and the evidence it quoted (a reason is never cut,
 * CLAUDE.md #26: a long list is split across messages), and offers the two decisions:
 *   [Fix now]   the same branch, every blocker handed to Antigravity at once (cp:fix, handled in blocked-callbacks.ts)
 *   [Close PR]  drop it (cp:close_pr)
 * Pure: no Telegram client, no network, no clock.
 */
import { InlineKeyboard } from "grammy";
import type { ReviewFinding } from "../tools/review-verdict.js";
import { assertHttpsUrl, assertNonce, callbackData, field, packLines, type Card } from "./coding-cards.js";

export interface BlockedCardInput {
  /** owner/name */
  repo: string;
  pr: number;
  /** The issue the PR answers (task/issue-N branch). Without it nothing can be dispatched, so there is no Fix now button. */
  issue?: number | undefined;
  title: string;
  branch: string;
  baseRef: string;
  /** Every blocker of the verdict for the head this card is about. */
  blockers: readonly ReviewFinding[];
  /** Non-blocking findings, counted only. */
  otherCount: number;
  url: string;
  nonce: string;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function where(f: ReviewFinding): string {
  return f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : "";
}

export function renderBlockedCard(i: BlockedCardInput): Card {
  assertNonce(i.nonce);
  assertHttpsUrl(i.url);
  const title = String(i.title ?? "").replace(/\s+/g, " ").trim() || "(no title)";
  const lines: string[] = [];
  lines.push(...field("🛑 PR #" + String(i.pr) + " is blocked in " + i.repo + ": ", title));
  lines.push(`pr-brain wants changes before this can merge. ${plural(i.blockers.length, "blocker")}:`);
  i.blockers.forEach((b, n) => {
    lines.push(...field(`${n + 1}. `, b.claim + where(b)));
    lines.push(...field("   Evidence: ", b.evidence));
  });
  if (i.otherCount > 0) lines.push(`Plus ${plural(i.otherCount, "non-blocking note")} on the PR.`);
  lines.push("");
  if (i.issue !== undefined) {
    lines.push(...field("Fix now: ", `Antigravity fixes all ${i.blockers.length} on ${i.branch} (merges into ${i.baseRef}), the same PR, nothing new filed. pr-brain re-reviews the new commit and you get a new card.`));
  } else {
    lines.push(...field("This PR is not linked to an issue ", `(its branch is ${i.branch}, not task/issue-N), so the pipeline cannot dispatch a fix for it. Fix it by hand, or close it.`));
  }
  lines.push("Close PR: closes it without merging. Reopen it from GitHub if you change your mind.");

  const keyboard = new InlineKeyboard();
  if (i.issue !== undefined) keyboard.text("🔧 Fix now", callbackData("fix", i.nonce));
  keyboard.text("🚫 Close PR", callbackData("close_pr", i.nonce)).row();
  keyboard.url("🔗 Open PR", i.url);
  return { html: packLines(lines), keyboard };
}
