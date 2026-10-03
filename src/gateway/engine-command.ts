/**
 * FounderOS — /engine
 * ===================
 * Shows or switches the default coding CLI that `/task` hands work to:
 *
 *   /engine           → which one is the default, and how to change it
 *   /engine claude    → Claude Code from now on
 *   /engine agy       → Google Antigravity from now on
 *
 * The default is one word in ~/.claude/coding-engine. The VPS dispatcher reads that file on its next
 * tick (deploy/lib/engine.sh), so what this replies must be what the file holds. A switch is therefore
 * confirmed by reading the file back, never by trusting that the write returned: a reply that says
 * "now Claude Code" while the daemon still reads agy sends the next task to the wrong CLI.
 *
 * Tasks already filed keep the `engine:*` label they were filed with; only new tasks follow the default.
 */

import type { Context } from "grammy";
import { engineDisplay, parseEngine, readDefaultEngine, writeDefaultEngine, type Engine } from "../tools/coding-engine.js";

export interface EngineCommandDeps {
  readonly read: () => Engine;
  readonly write: (engine: Engine) => void;
}

const REAL_DEPS: EngineCommandDeps = { read: () => readDefaultEngine(), write: (engine) => writeDefaultEngine(engine) };

const HOW_TO_SWITCH = (current: Engine): string => {
  const other: Engine = current === "claude" ? "agy" : "claude";
  return `Switch it with /engine ${other}. For one task only, start it with /claude or /agy instead of /task.`;
};

export async function handleEngine(ctx: Context, deps: EngineCommandDeps = REAL_DEPS): Promise<void> {
  const arg = (ctx.match?.toString() ?? "").trim();

  if (!arg) {
    const current = deps.read();
    await ctx.reply(`Default coding engine: ${engineDisplay(current)}. /task goes to it.\n${HOW_TO_SWITCH(current)}`);
    return;
  }

  // parseEngine knows whole names only, so "claude agy" is refused rather than read as "claude".
  const wanted = parseEngine(arg);
  if (!wanted) {
    await ctx.reply(`"${arg}" is not an engine I can run. Use /engine claude or /engine agy.`);
    return;
  }

  let failure: string | undefined;
  try {
    deps.write(wanted);
  } catch (err) {
    // Not swallowed: the reason goes into the reply below, and the default is read back, not assumed.
    failure = err instanceof Error ? err.message : String(err);
  }

  const now = deps.read();
  if (!failure && now !== wanted) failure = "the file still holds the old value after the write";
  if (failure) {
    await ctx.reply(`Could not save the default: ${failure}. It is still ${engineDisplay(now)}.`);
    return;
  }

  await ctx.reply(
    `Default coding engine is now ${engineDisplay(now)}. /task goes to it. ` +
      `Tasks already filed keep the engine they were filed with.`,
  );
}
