/**
 * FounderOS — /focus and /projects
 * =================================
 * The founder says what he is focused on, and what he is working on, in two seconds:
 *
 *   /focus Close the Acme pilot          sets current_focus
 *   /focus                               shows it, with the date he last confirmed it
 *   /projects FounderOS; Naggar site     sets active_projects (a ";" between projects)
 *   /projects                            shows them, with the date
 *
 * ZERO MODEL CALLS, deliberately. The alternative was a kernel turn (planner, worker,
 * synthesizer: paid, slow, and free to reword what he said) to store one sentence. The
 * value goes through the same guard update_context uses (sanitizeContextUpdates), so
 * the limits are the same, and is stamped as the founder's in context_meta, which is
 * what tells a later read that he, not the June seed, wrote it.
 *
 * WHY IT EXISTS. On 2026-09-29 "what am I focused on?" was answered with June's plan:
 * the value came from the seed, nothing dated it, and update_context rejected
 * `current_focus` as an unrecognised key, so there was no way to correct it short of
 * editing the database. Both commands are owner-only (chat-access.ts): they change
 * what every later answer treats as true.
 *
 * Replies are plain text, never HTML: the text is the founder's own and may contain
 * "<" or "&". Every reply is bounded by construction (a focus is at most
 * CONTEXT_FOCUS_MAX_CHARS, a project list at most eight entries), far under Telegram's cap.
 */

import type { Context } from "grammy";
import { TENANT } from "../core/config.js";
import { appTimeZone } from "../core/time.js";
import { getFounderContext, upsertFounderContext } from "../db/queries.js";
import { childLogger } from "../infra/logger.js";
import { sanitizeContextUpdates } from "../tools/context-guard.js";
import { contextTagRenderer } from "../tools/context-render.js";

const log = childLogger({ module: "gateway:focus" });

const FOCUS_KEY = "current_focus";
const PROJECTS_KEY = "active_projects";

/** How much of a database error is echoed to the founder. */
const ERROR_ECHO_MAX_CHARS = 200;

export interface FocusDeps {
  readonly getContext: () => Promise<Record<string, unknown>>;
  /** Writes the updates as the founder's: context_meta dates them (upsertFounderContext). */
  readonly saveContext: (updates: Record<string, unknown>) => Promise<void>;
  readonly now: () => Date;
  readonly timeZone: () => string;
}

function defaultDeps(): FocusDeps {
  return {
    getContext: () => getFounderContext(TENANT),
    saveContext: (updates) => upsertFounderContext(TENANT, updates, "founder"),
    now: () => new Date(),
    timeZone: appTimeZone,
  };
}

const argsOf = (ctx: Context): string => (typeof ctx.match === "string" ? ctx.match.trim() : "");

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, ERROR_ECHO_MAX_CHARS);

const itemText = (item: unknown): string => (typeof item === "string" ? item : JSON.stringify(item));

interface Spec {
  readonly key: string;
  readonly command: string;
  /** What the command changes, for "Could not read your focus". */
  readonly what: string;
  /** How to try again. */
  readonly again: string;
  /** The value as the reply shows it, or null when the row holds none. */
  readonly show: (value: unknown) => string | null;
  /** The reply for a value with its date tag. */
  readonly reply: (shown: string, tag: string, saved: boolean) => string;
  readonly none: string;
}

const numbered = (items: readonly unknown[]): string => items.map((item, i) => `${i + 1}. ${itemText(item)}`).join("\n");

const FOCUS: Spec = {
  key: FOCUS_KEY,
  command: "/focus",
  what: "your focus",
  again: "Send /focus <text> again.",
  show: (value) => (typeof value === "string" && value.trim() !== "" ? value : null),
  reply: (shown, tag, saved) =>
    saved ? `Focus saved: ${shown}\n${tag}` : `Current focus: ${shown}\n${tag}\n\nSend /focus <text> to replace it.`,
  none: "no focus set - send /focus <text>",
};

const PROJECTS: Spec = {
  key: PROJECTS_KEY,
  command: "/projects",
  what: "your projects",
  again: "Send /projects <a>; <b> again.",
  show: (value) => (Array.isArray(value) && value.length > 0 ? numbered(value) : null),
  reply: (shown, tag, saved) =>
    saved
      ? `Projects saved:\n${shown}\n${tag}`
      : `Active projects:\n${shown}\n${tag}\n\nSend /projects <a>; <b> to replace the list.`,
  none: "no projects set - send /projects <a>; <b>",
};

/** The row, or null after telling the founder the database could not be read. */
async function readRow(ctx: Context, deps: FocusDeps, spec: Spec): Promise<Record<string, unknown> | null> {
  try {
    return await deps.getContext();
  } catch (err) {
    log.error({ err: errorText(err), key: spec.key }, "Founder context read failed for a command");
    await ctx.reply(`Could not read ${spec.what}: the database is unreachable (${errorText(err)}).`);
    return null;
  }
}

async function replyWithValue(ctx: Context, deps: FocusDeps, spec: Spec, row: Record<string, unknown>, saved: boolean): Promise<void> {
  const shown = spec.show(row[spec.key]);
  if (shown === null) {
    // Right after a save this is not "nothing set": it is a write that cannot be seen. Say so.
    await ctx.reply(saved ? `Saved, but reading it back did not show ${spec.what}. Send ${spec.command} to check.` : spec.none);
    return;
  }
  const tag = contextTagRenderer(row, deps.now(), {
    timeZone: deps.timeZone(),
    warn: (problem) => log.warn({ problem }, "founder_context dates unreadable — shown as 'date unknown'"),
  })(spec.key);
  await ctx.reply(spec.reply(shown, tag, saved));
}

async function show(ctx: Context, deps: FocusDeps, spec: Spec): Promise<void> {
  const row = await readRow(ctx, deps, spec);
  if (row !== null) await replyWithValue(ctx, deps, spec, row, false);
}

/**
 * Validate through the update_context guard, store as the founder's, then read the
 * row back and answer from what is stored: the reply is the evidence, not a promise.
 */
async function save(ctx: Context, deps: FocusDeps, spec: Spec, value: unknown): Promise<void> {
  const { clean, rejected } = sanitizeContextUpdates({ [spec.key]: value }, { founderCommand: true });
  if (clean[spec.key] === undefined) {
    const why = rejected.map((r) => r.reason).join("; ") || "nothing valid to save";
    await ctx.reply(`Not saved: ${why}. ${spec.again}`);
    return;
  }
  try {
    await deps.saveContext(clean);
  } catch (err) {
    log.error({ err: errorText(err), key: spec.key }, "Founder context write failed for a command");
    await ctx.reply(`Not saved: could not reach the database (${errorText(err)}). Nothing was changed. ${spec.again}`);
    return;
  }
  log.info({ key: spec.key }, "Founder context set by command");
  let stored: Record<string, unknown>;
  try {
    stored = await deps.getContext();
  } catch (err) {
    log.error({ err: errorText(err), key: spec.key }, "Founder context read-back failed after a command write");
    await ctx.reply(`Saved, but I could not read it back to confirm (${errorText(err)}). Send ${spec.command} to check.`);
    return;
  }
  await replyWithValue(ctx, deps, spec, stored, true);
}

/** /focus [text] */
export async function handleFocus(ctx: Context, deps: FocusDeps = defaultDeps()): Promise<void> {
  const text = argsOf(ctx);
  if (text === "") return show(ctx, deps, FOCUS);
  return save(ctx, deps, FOCUS, text);
}

/** /projects [a; b; …] */
export async function handleProjects(ctx: Context, deps: FocusDeps = defaultDeps()): Promise<void> {
  const text = argsOf(ctx);
  if (text === "") return show(ctx, deps, PROJECTS);
  const names = text.split(";").map((name) => name.trim()).filter((name) => name !== "");
  if (names.length === 0) {
    await ctx.reply("I found no project names in that. Send /projects <a>; <b> with a semicolon between projects.");
    return;
  }
  return save(ctx, deps, PROJECTS, names);
}
