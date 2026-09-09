/**
 * FounderOS — /task
 * =================
 * The registered entry point to the Claude↔Antigravity loop:
 *
 *   /task fix the flaky CSV export
 *   /task repo:hulda fix the hero layout
 *
 * files an `agent:ready` GitHub issue, the VPS `agent-dispatch` daemon claims it and
 * runs headless Antigravity, `pr-brain` gates the resulting PR, and Antigravity is
 * re-dispatched on anything the review leaves uncleared.
 *
 * WHY THIS COMMAND EXISTS AT ALL. Dispatch already worked — by typing a paragraph of
 * plain English at the bot. That is undiscoverable: it appears in no menu, so the only
 * way to know it was to have written it. This is the same gap `/draft` closed for the
 * job brief (see jobhunt-commands.ts).
 *
 * REPO RESOLUTION IS PURE CODE, DELIBERATELY. `repo:` is parsed and checked against the
 * allowlist here, before any model call: an unknown or ambiguous hint is refused for
 * free, and the planner never gets a chance to invent a target. What the model IS
 * needed for is the opposite direction — turning one line of intent into the complete
 * template-shaped brief `agent:ready` promises (Goal, Scope, Verification…), which is
 * why this hands off to the ordinary kernel turn rather than filing an issue itself.
 * A stub issue would burn a real Antigravity run on an unusable brief.
 *
 * Handing off to the kernel also means the dispatch still stops at the normal HITL
 * card: the founder approves a named repository before anything is filed.
 */

import type { Context } from "grammy";
import { DISPATCH_REPO_ALLOWLIST, DEFAULT_DISPATCH_REPO, matchAllowlistedRepos } from "../tools/dispatch-repos.js";

const REPO_PREFIX = "repo:";

const USAGE = [
  "Usage: /task <what you want built>",
  "",
  "Examples:",
  "  /task fix the flaky CSV export in the jobhunt brief",
  "  /task repo:hulda make the hero section responsive on mobile",
  "",
  `Repos: ${DISPATCH_REPO_ALLOWLIST.join(", ")} (defaults to FounderOS).`,
  "",
  "I expand this into a full brief, show you an approval card, then file it as an",
  "agent:ready issue. Antigravity implements it and Claude reviews the PR.",
].join("\n");

export interface TaskArgs {
  readonly repo: string;
  readonly text: string;
}

export type TaskParse = { readonly ok: true; readonly args: TaskArgs } | { readonly ok: false; readonly message: string };

/**
 * Splits `[repo:<hint>] <free text>`.
 *
 * `repo:` is honoured ONLY as the first token. Scanning the whole string would let
 * "mention repo:hulda in the readme" retarget the dispatch — the instruction was about
 * the string, not about where the work should land.
 */
export function parseTaskArgs(raw: string): TaskParse {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, message: USAGE };

  const [first, ...rest] = trimmed.split(/\s+/);
  if (!first?.toLowerCase().startsWith(REPO_PREFIX)) {
    return { ok: true, args: { repo: DEFAULT_DISPATCH_REPO, text: trimmed } };
  }

  const hint = first.slice(REPO_PREFIX.length);
  const matches = matchAllowlistedRepos(hint);

  if (matches.length === 0) {
    return {
      ok: false,
      message:
        `"${hint}" is not a repository I can dispatch to.\n\n` +
        `Allowed: ${DISPATCH_REPO_ALLOWLIST.join(", ")}.\n` +
        "Adding another one is a code change, not a setting.",
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      message:
        `"${hint}" is ambiguous — it matches more than one repository:\n` +
        matches.map((m) => `  · ${m}`).join("\n") +
        "\n\nName it more precisely.",
    };
  }

  const text = rest.join(" ").trim();
  if (!text) return { ok: false, message: USAGE };

  return { ok: true, args: { repo: matches[0] as string, text } };
}

/**
 * The instruction handed to the kernel.
 *
 * Explicitly forbids implementing the work inline: without that the planner edits
 * files, reports success, and never files the issue — /task would look like it worked
 * while the loop never ran, which is the exact silent-success failure the receipts
 * discipline exists to catch.
 */
export function buildTaskInstruction(args: TaskArgs): string {
  return [
    `Dispatch this engineering task to Google Antigravity by calling the dispatch_antigravity_task tool.`,
    ``,
    `Target repository: ${args.repo}`,
    ``,
    `The founder's request, verbatim:`,
    args.text,
    ``,
    `Expand it into a complete, self-contained brief conforming to the agent-task template:`,
    `a title with a conventional-commit prefix, what "done" means to an executor with no`,
    `prior context, the exact files or subsystem in scope, the expected behaviour, and`,
    `verification commands that are real for THAT repository.`,
    ``,
    `Do not implement the work yourself and do not edit any files — your only job here is`,
    `to file the dispatch issue. Pass repo exactly as "${args.repo}".`,
  ].join("\n");
}

export interface TaskCommandDeps {
  /** The normal kernel turn — same path a typed message takes. */
  readonly runKernelText: (ctx: Context, text: string) => Promise<void>;
}

export async function handleTask(ctx: Context, deps: TaskCommandDeps): Promise<void> {
  const parsed = parseTaskArgs(ctx.match?.toString() ?? "");
  if (!parsed.ok) {
    await ctx.reply(parsed.message);
    return;
  }

  await deps.runKernelText(ctx, buildTaskInstruction(parsed.args));
}
