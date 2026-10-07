/**
 * FounderOS — /goal: what each subcommand does
 * ============================================
 * The parser (src/goals/parse.ts) decides WHAT was asked; this file does it and words the reply. The rules
 * every reply follows:
 *   - it names the goal it touched, by number AND title, because `<n>` is a position in a list that can
 *     shift under him (a goal finishing, another added), and the title is how he notices;
 *   - nothing is ever deleted: `done` and `drop` change a status and keep the row and its history;
 *   - a bad input is answered with the exact field at fault, with buttons where the options are finite.
 *
 * Owner-only, by OWNER_ONLY_COMMANDS in chat-access.ts (commands) and by the check in goal-buttons.ts
 * (taps). No model-callable tool creates or edits a goal: this is the only write path.
 */

import type { Context } from "grammy";
import { esc } from "../tools/jobhunt/telegram-format.js";
import { encodeGoalCallback, type GoalCallback } from "../goals/callbacks.js";
import { formatShortDate, localDateKey, startOfLocalDay } from "../goals/local-date.js";
import { METRICS, METRIC_KEYS } from "../goals/metrics.js";
import { formatNumber } from "../goals/numeric.js";
import { parseGoalCommand, type ChoiceRequest, type GoalDraft, type ParseIssue } from "../goals/parse.js";
import type { GoalRepo } from "../goals/repo.js";
import type { GoalRow } from "../goals/types.js";
import { EMPLOYER_REPO_OWNERS, type GoalCommandDeps } from "./goal-deps.js";
import { labelForRepo } from "./repo-picker.js";

interface Button {
  readonly text: string;
  readonly callback_data: string;
}
type Keyboard = { inline_keyboard: Button[][] };

export interface DispatchOptions {
  /** The founder's own message: pickers and confirmations are sent as replies to it, so the conversation is the state. */
  readonly replyTo?: number;
  /** A metric chosen with a button, replacing whatever `metric=` said. */
  readonly metricOverride?: string;
}

export async function replyHtml(ctx: Context, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra });
}

/**
 * Reply to the founder's own message. `allow_sending_without_reply` because he may delete his command right
 * after sending it: without it Telegram refuses the reply ("message to be replied not found") AFTER the goal
 * was already created, and he would be told a goal failed that in fact exists.
 */
const replyTarget = (messageId: number): { reply_parameters: { message_id: number; allow_sending_without_reply: true } } => ({
  reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
});

const errorText = (err: unknown): string => (err instanceof Error && err.message !== "" ? err.message.slice(0, 200) : "unknown error");
const quoted = (g: GoalRow): string => `“${esc(g.title)}”`;
const specOf = (g: Pick<GoalRow, "metric_key" | "metric_arg">): string => esc(g.metric_arg === null ? g.metric_key : `${g.metric_key}:${g.metric_arg}`);
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The text `/goal` alone answers with: the whole grammar, and every metric. */
export function usageText(): string {
  const metrics = METRIC_KEYS.map((key) => {
    const def = METRICS[key];
    const shape = def.arg === null ? "" : { profile: ":&lt;profile&gt;", repo: ":&lt;owner/repo&gt;", action: ":&lt;action&gt;" }[def.arg];
    return `• <code>${key}${shape}</code>: ${esc(def.summary)}`;
  });
  return [
    "<b>Goals</b>: what you are moving, measured by code from real events and reported every morning at 09:00.",
    "",
    "<code>/goals</code>: the list, with today's value and pace",
    "<code>/goal add Ship one fix a week | metric=prs_merged_7d:owner/repo target=1 by=2026-10-31</code>",
    "<code>/goal 2 1200</code>: report a value for a manual goal",
    "<code>/goal done 2</code> · <code>/goal drop 2</code> · <code>/goal unblock 2</code>",
    "<code>/goal block 2 waiting on the visa decision until=2026-10-15</code>",
    "",
    "The number is the goal's position in /goals. It can shift when a goal finishes, so every reply repeats the title. Nothing is ever deleted.",
    "",
    "<b>Metrics</b>",
    ...metrics,
  ].join("\n");
}

function button(text: string, cb: GoalCallback): Button[] {
  const data = encodeGoalCallback(cb);
  return data === null ? [] : [{ text, callback_data: data }];
}

/** The buttons for a finite choice, two to a row; undefined when none could be built. */
async function choiceKeyboard(deps: GoalCommandDeps, choice: ChoiceRequest): Promise<Keyboard | undefined> {
  let buttons: Button[] = [];
  if (choice.kind === "metric-family") {
    buttons = METRIC_KEYS.flatMap((family) => button(family, { kind: "metric", family }));
  } else if (METRICS[choice.family].arg === "profile") {
    buttons = deps.profiles().ids.flatMap((id) => button(id, { kind: "arg", family: choice.family, arg: id }));
  } else if (METRICS[choice.family].arg === "repo") {
    const slugs = (await deps.repoChoices()).filter((slug) => !EMPLOYER_REPO_OWNERS.includes((slug.split("/")[0] ?? "").toLowerCase()));
    buttons = slugs.flatMap((slug) => button(labelForRepo(slug), { kind: "arg", family: choice.family, arg: slug }));
  }
  if (buttons.length === 0) return undefined;
  const rows: Button[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return { inline_keyboard: rows };
}

async function replyIssues(ctx: Context, deps: GoalCommandDeps, issues: readonly ParseIssue[], replyTo?: number, rawArgs?: string): Promise<void> {
  const choice = issues.find((i) => i.choices !== undefined)?.choices;
  const keyboard = choice ? await choiceKeyboard(deps, choice) : undefined;
  const lines = [
    `❌ <b>Not done.</b> ${issues.length === 1 ? "One thing to fix" : `${issues.length} things to fix`}:`,
    ...issues.map((i) => `• <b>${esc(i.field)}</b>: ${esc(i.message)}`),
  ];
  if (rawArgs) {
    lines.push("", `Command: <code>/goal ${esc(rawArgs)}</code>`);
  }
  if (choice?.kind === "metric-family") {
    lines.push("", "<b>Metrics</b>", ...METRIC_KEYS.map((k) => `• <code>${k}</code>: ${esc(METRICS[k].summary)}`));
  }
  await replyHtml(ctx, lines.join("\n"), {
    ...(keyboard ? { reply_markup: keyboard } : {}),
    ...(keyboard && replyTo !== undefined ? replyTarget(replyTo) : {}),
  });
}

async function addGoal(ctx: Context, deps: GoalCommandDeps, repo: GoalRepo, draft: GoalDraft, replyTo?: number): Promise<void> {
  const goal = await repo.addGoal(
    deps.tenant,
    {
      title: draft.title,
      metric_key: draft.metricKey,
      metric_arg: draft.metricArg,
      target: draft.target,
      baseline: draft.baseline,
      due_on: draft.dueOn,
      priority: draft.priority,
    },
    deps.now(),
  );
  const n = (await repo.listOpenGoals(deps.tenant)).findIndex((g) => g.id === goal.id) + 1;
  const due = goal.due_on === null ? "no due date" : `due ${formatShortDate(goal.due_on)}`;
  await replyHtml(
    ctx,
    [
      `✅ Goal ${n} added: ${quoted(goal)}`,
      `${specOf(goal)} · target ${formatNumber(goal.target)} · ${due}`,
      draft.metricKey === "manual" ? `Report its value with <code>/goal ${n} &lt;value&gt;</code>.` : "It is measured from real events.",
      "It is in /goals now and in the next 09:00 standup.",
    ].join("\n"),
    replyTo !== undefined ? replyTarget(replyTo) : {},
  );
}

/** The goal at position `n` of the current open list, or null after saying why there is none. */
async function goalAt(ctx: Context, deps: GoalCommandDeps, repo: GoalRepo, n: number): Promise<GoalRow | null> {
  const open = await repo.listOpenGoals(deps.tenant);
  const goal = open[n - 1];
  if (goal) return goal;
  await replyHtml(
    ctx,
    open.length === 0
      ? "You have no open goals. Add one with /goal add (see /goal)."
      : `There is no goal ${n}: you have ${plural(open.length, "open goal")}. /goals shows them.`,
  );
  return null;
}

async function setValue(ctx: Context, deps: GoalCommandDeps, repo: GoalRepo, n: number, value: number): Promise<void> {
  const goal = await goalAt(ctx, deps, repo, n);
  if (goal === null) return;
  if (goal.metric_key !== "manual") {
    await replyHtml(
      ctx,
      `Goal ${n} ${quoted(goal)} is measured automatically (${specOf(goal)}), so it takes no value. Only manual goals do: add one with <code>metric=manual</code>.`,
    );
    return;
  }
  await repo.recordManualValue(deps.tenant, goal.id, value, deps.now());
  const was = goal.manual_value === null ? "" : ` (was ${formatNumber(goal.manual_value)})`;
  await replyHtml(
    ctx,
    `Goal ${n} ${quoted(goal)}: recorded ${formatNumber(value)}${was}, target ${formatNumber(goal.target)}. ` +
      (value >= goal.target ? "That reaches the target: the next standup marks it done." : "The next standup shows its pace."),
  );
}

async function changeStatus(
  ctx: Context,
  deps: GoalCommandDeps,
  repo: GoalRepo,
  command: { kind: "done" | "drop" | "unblock" | "block"; n: number; reason?: string; until?: string | null },
): Promise<void> {
  const goal = await goalAt(ctx, deps, repo, command.n);
  if (goal === null) return;
  const head = `Goal ${command.n} ${quoted(goal)}`;
  const now = deps.now();
  switch (command.kind) {
    case "done":
      await repo.updateStatus(deps.tenant, goal.id, { status: "done" }, now);
      await replyHtml(ctx, `✅ ${head} marked done. The goals below it move up: /goals shows the list.`);
      return;
    case "drop":
      await repo.updateStatus(deps.tenant, goal.id, { status: "dropped" }, now);
      await replyHtml(ctx, `${head} dropped. Its history is kept; it just leaves the list.`);
      return;
    case "unblock":
      if (goal.status !== "blocked") {
        await replyHtml(ctx, `${head} is not blocked.`);
        return;
      }
      await repo.updateStatus(deps.tenant, goal.id, { status: "active" }, now);
      await replyHtml(ctx, `▶️ ${head} is active again.`);
      return;
    case "block": {
      const until = command.until ?? null;
      const blockedUntil = until === null ? null : startOfLocalDay(until, deps.timeZone());
      await repo.updateStatus(deps.tenant, goal.id, { status: "blocked", blocker: command.reason ?? "", blockedUntil }, now);
      await replyHtml(
        ctx,
        `⏸ ${head} blocked: ${esc(command.reason ?? "")} (${until === null ? "no end date" : `until ${formatShortDate(until)}`}). ` +
          "It sits under Blocked in the standup and is not measured meanwhile.",
      );
      return;
    }
  }
}

/** Parse and run one `/goal …` command (or one re-parsed by a picker button). Never throws: a failure is answered and logged. */
export async function dispatchGoalCommand(ctx: Context, deps: GoalCommandDeps, rawArgs: string, opts: DispatchOptions = {}): Promise<void> {
  const parsed = parseGoalCommand(rawArgs, {
    today: localDateKey(deps.now(), deps.timeZone()),
    resolveProfile: deps.profiles().resolve,
    ...(opts.metricOverride !== undefined ? { metricOverride: opts.metricOverride } : {}),
  });
  if (!parsed.ok) {
    await replyIssues(ctx, deps, parsed.issues, opts.replyTo, rawArgs);
    return;
  }
  const command = parsed.command;
  if (command.kind === "usage") {
    await replyHtml(ctx, usageText());
    return;
  }
  try {
    const repo = await deps.repo();
    switch (command.kind) {
      case "add":
        await addGoal(ctx, deps, repo, command.draft, opts.replyTo);
        return;
      case "set-value":
        await setValue(ctx, deps, repo, command.n, command.value);
        return;
      default:
        await changeStatus(ctx, deps, repo, command);
    }
  } catch (err) {
    deps.log.error({ component: "goal-commands", command: command.kind, error: errorText(err) }, "Goal command failed");
    await replyHtml(ctx, `❌ Could not run /goal ${command.kind}: ${esc(errorText(err))}. Check the server log.`);
  }
}

export { errorText };
