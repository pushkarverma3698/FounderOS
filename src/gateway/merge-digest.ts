/**
 * FounderOS — the evening merge list
 * ==================================
 * One message a day: the pull requests that are reviewed, green and mergeable, each with a Merge button.
 *
 * WHY. In 7 days agents opened 13 PRs and FounderOS merged 4; Oplify merged 0 of 6 (capability audit C-P0-4). The
 * work was done and nobody was told it was waiting in one place: 259 per-event pr-brain and dispatch messages went
 * out, and none of them was "these are ready, here is the button".
 *
 * WHAT THIS IS NOT. It is not the `PR_BRAIN_MERGE` switch. That switch lets the daemon merge on its own and stays off.
 * A button here is the founder's own tap on one PR, and a second tap confirms it, because one stray tap on a phone
 * must not deploy a repository that deploys on merge.
 *
 * PURE. Rendering, the callback payload and the merge verdict. The reads and the merge are in merge-digest-run.ts and
 * merge-digest-callback.ts, so every refusal below is fixture-tested offline.
 */

import { DISPATCH_REPO_ALLOWLIST } from "../tools/dispatch-repos.js";
import { esc } from "../tools/jobhunt/telegram-format.js";
import type { ReadyMergePr, Unreachable } from "./tasks-ready.js";

export const MERGE_CALLBACK_PREFIX = "md:";

/** ask = the first tap, yes = confirmed, no = cancelled. */
export type MergeAction = "ask" | "yes" | "no";

const ACTION_CODE: Record<MergeAction, string> = { ask: "a", yes: "y", no: "n" };
const CODE_ACTION: Record<string, MergeAction> = { a: "ask", y: "yes", n: "no" };

/** Buttons shown. Telegram allows 100, but a keyboard longer than a screen is not a list a phone can tap. */
export const MAX_DIGEST_PRS = 8;
/** Short head sha carried in the button: the tap is refused when the head has moved since the list was sent. */
export const SHA_PREFIX_LEN = 7;
/** Keeps the message under Telegram's 4096 characters: eight long titles plus a pile of unreadable repos must still send. */
const MAX_TITLE_CHARS = 100;
export const MAX_UNREADABLE_SHOWN = 5;
const clip = (t: string): string => (t.length > MAX_TITLE_CHARS ? `${t.slice(0, MAX_TITLE_CHARS - 1)}…` : t);

export interface MergeCallback {
  readonly action: MergeAction;
  readonly repoName: string;
  readonly pr: number;
  readonly sha7: string;
}

const shortRepo = (slug: string): string => slug.split("/")[1] ?? slug;

/** `md:<a|y|n>:<repo name>:<pr>:<sha7>`. Telegram caps callback data at 64 bytes; the longest allowlisted repo fits. */
export function mergeCallbackData(action: MergeAction, repoSlug: string, pr: number, headSha: string): string {
  return `${MERGE_CALLBACK_PREFIX}${ACTION_CODE[action]}:${shortRepo(repoSlug)}:${pr}:${headSha.slice(0, SHA_PREFIX_LEN)}`;
}

export function parseMergeCallback(data: string): MergeCallback | null {
  if (!data.startsWith(MERGE_CALLBACK_PREFIX)) return null;
  const m = /^md:([ayn]):([A-Za-z0-9._-]+):(\d{1,7}):([0-9a-f]{7})$/.exec(data);
  if (!m) return null;
  const action = CODE_ACTION[m[1]!];
  return action ? { action, repoName: m[2]!, pr: Number(m[3]), sha7: m[4]! } : null;
}

/** The allowlisted slug for a repo name, or null when the name is unknown or ambiguous. Never trusts the payload's owner. */
export function resolveMergeRepo(repoName: string): string | null {
  const hits = DISPATCH_REPO_ALLOWLIST.filter((slug) => shortRepo(slug).toLowerCase() === repoName.toLowerCase());
  return hits.length === 1 ? hits[0]! : null;
}

export interface MergeButton {
  readonly label: string;
  readonly data: string;
}

export interface MergeDigest {
  readonly text: string;
  /** One button per row. */
  readonly buttons: readonly MergeButton[];
}

const deploysNote = (base: string | undefined): string => (base === "main" ? " ⚠️ deploys on merge" : "");

/**
 * The digest, or null when there is nothing to say. A day with no ready PR and nothing unreadable sends no message:
 * an empty list every evening teaches the founder to stop opening it. An unreadable repo is always said, because a
 * repo whose token expired looks exactly like a repo with nothing waiting.
 */
export function renderMergeDigest(
  ready: readonly ReadyMergePr[],
  unreachable: readonly Unreachable[] = [],
): MergeDigest | null {
  // A row with no head sha cannot be pinned, so it gets no button. /tasks still lists it.
  const mergeable = ready.filter((p) => p.headSha !== undefined && p.headSha.length >= SHA_PREFIX_LEN);
  if (mergeable.length === 0 && unreachable.length === 0) return null;

  const shown = mergeable.slice(0, MAX_DIGEST_PRS);
  const lines: string[] = [];
  if (mergeable.length > 0) {
    lines.push(`🔀 <b>${mergeable.length} ready to merge</b> — reviewed, CI green, no conflicts`, "");
    shown.forEach((pr, i) => {
      const into = pr.base ? ` → ${esc(pr.base)}` : "";
      lines.push(
        `${i + 1}. <a href="${pr.url}">#${pr.prNumber}</a> <b>${esc(shortRepo(pr.repo))}</b>${into}${deploysNote(pr.base)}`,
        `   ${esc(clip(pr.title))}`,
      );
    });
    if (mergeable.length > shown.length) {
      lines.push("", `<i>+${mergeable.length - shown.length} more: send /tasks to see them.</i>`);
    }
    lines.push("", "<i>Tap a button, then confirm. Nothing merges on its own.</i>");
  }
  for (const miss of unreachable.slice(0, MAX_UNREADABLE_SHOWN)) {
    lines.push("", `⚠️ <b>${esc(shortRepo(miss.repo))}</b> could not be read — ${esc(clip(miss.error))}`);
  }
  if (unreachable.length > MAX_UNREADABLE_SHOWN) {
    lines.push("", `<i>+${unreachable.length - MAX_UNREADABLE_SHOWN} more could not be read: send /tasks to see them.</i>`);
  }

  const buttons = shown.map((pr, i) => ({
    label: `🔀 Merge ${i + 1} · ${shortRepo(pr.repo)} #${pr.prNumber}`,
    data: mergeCallbackData("ask", pr.repo, pr.prNumber, pr.headSha!),
  }));
  return { text: lines.join("\n").trim(), buttons };
}

/** The second tap's prompt: names the repo, the branch and the head it will merge, so the founder confirms a fact. */
export function renderMergeConfirm(args: {
  readonly repo: string;
  readonly pr: number;
  readonly title: string;
  readonly base: string;
  readonly sha7: string;
}): { text: string; buttons: readonly MergeButton[] } {
  const note = args.base === "main" ? "\n⚠️ <b>main deploys on merge.</b>" : "";
  return {
    text:
      `Merge <b>${esc(shortRepo(args.repo))} #${args.pr}</b> into <code>${esc(args.base)}</code>?\n` +
      `${esc(args.title)}\n<i>Head ${args.sha7}, reviewed and CI green when I checked just now.</i>${note}`,
    buttons: [
      { label: "✅ Yes, merge", data: mergeCallbackData("yes", args.repo, args.pr, args.sha7) },
      { label: "✖️ Cancel", data: mergeCallbackData("no", args.repo, args.pr, args.sha7) },
    ],
  };
}

/** What GitHub and the review trail say about one PR right now. */
export interface MergeFacts {
  readonly state: "open" | "closed";
  readonly merged: boolean;
  readonly draft: boolean;
  readonly headSha: string;
  readonly expectedSha7: string;
  readonly reviewedForHead: boolean;
  readonly greenCI: boolean;
  /** `null` while GitHub is still computing it. */
  readonly mergeable: boolean | null;
  readonly mergeableState: string | null;
}

export type MergeVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly already?: true };

/**
 * May this PR be merged by a tap? Every input that could not be confirmed refuses, with the reason in plain words:
 * a refusal that says "not ready" sends the founder to GitHub to find out why, which is the thing this removes.
 */
export function mergeVerdict(f: MergeFacts): MergeVerdict {
  if (f.merged) return { ok: false, reason: "It is already merged. Nothing to do.", already: true };
  if (f.state !== "open") return { ok: false, reason: "It was closed without merging." };
  if (!f.headSha.startsWith(f.expectedSha7)) {
    return { ok: false, reason: "New commits landed after this list was sent. It needs a fresh review first; nothing was merged." };
  }
  if (f.draft) return { ok: false, reason: "It is still a draft." };
  if (!f.reviewedForHead) return { ok: false, reason: "The review does not cover the current head." };
  if (!f.greenCI) return { ok: false, reason: "CI is not green on the current head." };
  if (f.mergeable === null) return { ok: false, reason: "GitHub is still working out whether it merges cleanly. Tap again in a minute." };
  if (!f.mergeable || f.mergeableState === "dirty") return { ok: false, reason: "It conflicts with its base branch." };
  if (f.mergeableState === "behind") return { ok: false, reason: "It is behind its base branch. Update the branch on GitHub first." };
  if (f.mergeableState === "blocked") {
    return { ok: false, reason: "Branch protection blocks it: a required check or review is missing for this head." };
  }
  return { ok: true };
}
