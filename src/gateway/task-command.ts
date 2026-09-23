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
import { DISPATCH_REPO_ALLOWLIST, matchAllowlistedRepos } from "../tools/dispatch-repos.js";
import { validateProjectRepoName } from "../tools/create-project-repo.js";
import {
  REPO_CALLBACK_PREFIX,
  buildRepoKeyboardRows,
  buildRepoPrompt,
  buildRepoQuestion,
  repoFromCallbackData,
  repoFromPrompt,
} from "./repo-picker.js";

const REPO_PREFIX = "repo:";

const USAGE = [
  "Usage: /task <what you want built>",
  "",
  "Example:",
  "  /task fix the flaky CSV export in the jobhunt brief",
  "",
  "I ask which repo with buttons — you never have to type a repo name.",
  "(/task repo:hulda <work> still skips the question if you prefer typing.)",
  "",
  "I expand this into a full brief, show you an approval card, then file it as an",
  "agent:ready issue. Antigravity implements it and Claude reviews the PR.",
].join("\n");

export interface TaskArgs {
  readonly repo: string;
  readonly text: string;
}

export type TaskParse =
  | { readonly ok: true; readonly args: TaskArgs }
  /** Work was described but no repository named — ask, with buttons. */
  | { readonly ok: false; readonly kind: "needs-repo"; readonly text: string }
  /** Nothing to build yet — offer the repo buttons and then ask for the work. */
  | { readonly ok: false; readonly kind: "needs-work"; readonly message: string }
  | { readonly ok: false; readonly kind: "refused"; readonly message: string };

/**
 * Splits `[repo:<hint>] <free text>`.
 *
 * `repo:` is honoured ONLY as the first token. Scanning the whole string would let
 * "mention repo:hulda in the readme" retarget the dispatch — the instruction was about
 * the string, not about where the work should land.
 *
 * AN UNNAMED REPO IS A QUESTION, NOT A DEFAULT. This used to fall through to
 * FounderOS, which meant `/task app fix the login` — the `repo:` prefix forgotten,
 * which is the single easiest thing about this command to forget — filed employer
 * work against FounderOS, with the stray word "app" still in the brief, and said
 * nothing. A wrong target that announces itself is recoverable; this one cost a
 * real Antigravity run to discover. Asking costs one tap.
 */
export function parseTaskArgs(raw: string, registered: readonly string[] = []): TaskParse {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, kind: "needs-work", message: USAGE };

  const [first, ...rest] = trimmed.split(/\s+/);
  if (!first?.toLowerCase().startsWith(REPO_PREFIX)) {
    return { ok: false, kind: "needs-repo", text: trimmed };
  }

  const hint = first.slice(REPO_PREFIX.length);
  const matches = matchAllowlistedRepos(hint, registered);

  if (matches.length === 0) {
    return {
      ok: false,
      kind: "refused",
      message:
        `"${hint}" is not a repository I can dispatch to.\n\n` +
        `Allowed: ${[...DISPATCH_REPO_ALLOWLIST, ...registered].join(", ")}.\n` +
        "Start a new one by asking me to create a project repo.",
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      kind: "refused",
      message:
        `"${hint}" is ambiguous — it matches more than one repository:\n` +
        matches.map((m) => `  · ${m}`).join("\n") +
        "\n\nName it more precisely.",
    };
  }

  const text = rest.join(" ").trim();
  if (!text) return { ok: false, kind: "needs-work", message: USAGE };

  return { ok: true, args: { repo: matches[0] as string, text } };
}

/**
 * `/task fix the thing` → `fix the thing`.
 *
 * Telegram delivers the founder's own message verbatim, including the slash and
 * the `@BotName` suffix a group chat adds. The dispatch brief must not inherit
 * either: "/task" in the goal line reads to an executor as part of the request.
 */
export function stripTaskCommand(raw: string): string {
  return raw.replace(/^\/task(@\w+)?\s*/i, "").trim();
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
  /**
   * Project repos this instance created, which are dispatchable without a code
   * change. Optional so every existing caller and test keeps the hardcoded-only
   * behaviour; supplied in production by the gateway.
   */
  readonly listRegisteredRepos?: () => Promise<readonly string[]>;
}

async function registeredRepos(deps: TaskCommandDeps): Promise<readonly string[]> {
  try {
    return (await deps.listRegisteredRepos?.()) ?? [];
  } catch {
    // allow-failopen: a registry that cannot be read must not take /task down for the hardcoded repos.
    return [];
  }
}

/** The repo buttons, as a grammy `reply_markup`. */
function repoKeyboard(registered: readonly string[]): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return { inline_keyboard: buildRepoKeyboardRows(registered) };
}

export async function handleTask(ctx: Context, deps: TaskCommandDeps): Promise<void> {
  const registered = await registeredRepos(deps);
  const parsed = parseTaskArgs(ctx.match?.toString() ?? "", registered);

  if (parsed.ok) {
    await deps.runKernelText(ctx, buildTaskInstruction(parsed.args));
    return;
  }

  if (parsed.kind === "refused") {
    await ctx.reply(parsed.message);
    return;
  }

  // Both remaining cases end in the same row of buttons. The difference is only
  // what happens after the tap, and that is decided at tap time by whether the
  // question is attached to a message that already describes the work — so the
  // branch lives in the callback, not here.
  //
  // `reply_parameters` is load-bearing, not decoration: it is what carries the
  // founder's UNTRUNCATED request across the button press. The echo in the
  // question is capped for legibility, so recovering the brief from the question
  // text would silently shorten it.
  const messageId = ctx.message?.message_id;
  await ctx.reply(
    parsed.kind === "needs-repo"
      ? buildRepoQuestion(parsed.text)
      : "🤖 <b>Which repo should I build in?</b>",
    {
      parse_mode: "HTML",
      reply_markup: repoKeyboard(registered),
      ...(parsed.kind === "needs-repo" && messageId ? { reply_parameters: { message_id: messageId } } : {}),
    },
  );
}

/**
 * A tapped repo button.
 *
 * Two outcomes, decided by whether the work is already known:
 *   · the question was asked about a `/task <work>` message → dispatch now
 *   · it was a bare `/task` → ask what to build, with `force_reply` so his answer
 *     comes back attached to the message naming the repository
 *
 * Returns false for a payload that is not a repo choice, so the caller can fall
 * through to its other callback handlers.
 */
export async function handleRepoChoice(ctx: Context, deps: TaskCommandDeps): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  // Checked BEFORE the registry read: approve/reject go through this same
  // handler, and making the HITL card wait on a database round trip to be told
  // "not mine" puts a query in front of the founder's approval tap.
  if (!data.startsWith(REPO_CALLBACK_PREFIX)) return false;

  const repo = repoFromCallbackData(data, await registeredRepos(deps));

  if (!repo) {
    // Not silence: a button that does nothing reads exactly like a dead bot, and
    // an unresolvable payload means the allowlist changed under a stale message.
    await ctx.answerCallbackQuery({ text: "That repo is no longer dispatchable", show_alert: true });
    return true;
  }

  await ctx.answerCallbackQuery({ text: `→ ${repo.split("/")[1] ?? repo}` });
  // Best-effort: the buttons are spent either way, and a failed edit (message too
  // old, already edited) must not stop the dispatch the founder just asked for.
  // allow-failopen: clearing a spent keyboard is cosmetic; the dispatch below is the actual work.
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => undefined);

  const original = ctx.callbackQuery?.message?.reply_to_message;
  const work = stripTaskCommand(
    (original && "text" in original ? (original.text as string | undefined) : undefined) ?? "",
  );

  if (!work) {
    await ctx.reply(buildRepoPrompt(repo), {
      parse_mode: "HTML",
      reply_markup: { force_reply: true, input_field_placeholder: "what should I build?" },
    });
    return true;
  }

  await deps.runKernelText(ctx, buildTaskInstruction({ repo, text: work }));
  return true;
}

/**
 * The founder's reply to a `buildRepoPrompt` message.
 *
 * Returns false when this text is not an answer to one, so the caller hands it
 * to the ordinary kernel turn untouched. The repository is read back out of the
 * message being replied to and re-validated, so nothing about the target is held
 * in memory between the two messages — a restart mid-flow loses nothing.
 */
export async function handleRepoReply(ctx: Context, deps: TaskCommandDeps): Promise<boolean> {
  const replied = ctx.message?.reply_to_message;
  const prompt = replied && "text" in replied ? (replied.text as string | undefined) : undefined;
  if (!prompt) return false;

  const repo = repoFromPrompt(prompt, await registeredRepos(deps));
  if (!repo) return false;

  const work = (ctx.message?.text ?? "").trim();
  if (!work) return false;

  await deps.runKernelText(ctx, buildTaskInstruction({ repo, text: work }));
  return true;
}

// ── /newproject ──────────────────────────────────────────────────────────────
//
// Starting a project is the one dispatch case /task cannot serve: there is nothing to
// dispatch to yet. Without its own entry point the capability is reachable only by
// guessing the right sentence at the bot, which is the discoverability gap this whole
// command surface exists to close.

const NEW_PROJECT_USAGE = [
  "Usage: /newproject <name> <what it is>",
  "",
  "Example:",
  "  /newproject turicks-pricing-api usage-based pricing service for Turicks",
  "",
  "Creates a PRIVATE repo under your account and lets the agent loop work in it.",
  "You approve the name before anything is created.",
].join("\n");

export interface NewProjectArgs {
  readonly name: string;
  readonly description: string;
}

export type NewProjectParse =
  | { readonly ok: true; readonly args: NewProjectArgs }
  | { readonly ok: false; readonly message: string };

/** Splits `<name> <description…>` and rejects a name GitHub would rewrite. */
export function parseNewProjectArgs(raw: string): NewProjectParse {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, message: NEW_PROJECT_USAGE };

  const [name, ...rest] = trimmed.split(/\s+/);
  const invalid = validateProjectRepoName(name ?? "");
  if (invalid) return { ok: false, message: `${invalid}\n\n${NEW_PROJECT_USAGE}` };

  return { ok: true, args: { name: name as string, description: rest.join(" ").trim() } };
}

/**
 * Routed through the kernel for the same reason as /task: the approval card belongs to
 * the tool, and a gateway-local card would resume an unrelated paused checkpoint.
 */
export function buildNewProjectInstruction(args: NewProjectArgs): string {
  return [
    `Start a new project by calling the create_project_repo tool.`,
    ``,
    `Repository name: ${args.name}`,
    `Description: ${args.description || "(none given)"}`,
    `Visibility: private — do not pass isPrivate unless the founder asked for a public repo.`,
    ``,
    `Call the tool once with exactly that name. Do not create files, do not scaffold`,
    `anything, and do not dispatch any work yet — creating the repository is the whole task.`,
  ].join("\n");
}

export async function handleNewProject(ctx: Context, deps: TaskCommandDeps): Promise<void> {
  const parsed = parseNewProjectArgs(ctx.match?.toString() ?? "");
  if (!parsed.ok) {
    await ctx.reply(parsed.message);
    return;
  }

  await deps.runKernelText(ctx, buildNewProjectInstruction(parsed.args));
}
