/**
 * C-P1-4: one "you can also…" line after a reply, at most once a day.
 *
 * He cannot ask for what he does not know exists (capability audit C-P1-4). After a
 * successful turn we name ONE tool from the department that just worked, that he has
 * not used and we have not suggested before. Pure picker + a thin DB edge.
 *
 * Storage is the audit trail, not a new table: one `action_log` row per hint, keyed
 * `capability_hint:<tenant>:<UTC day>`. The unique key IS the once-a-day limit (a second
 * claim loses the insert), and the rows' payloads are the "already suggested" set.
 */
import { and, eq } from "drizzle-orm";
import type { Context } from "grammy";
import { getDb } from "../db/client.js";
import { actionLog } from "../db/schema.js";
import { writeAuditEntry } from "../db/queries.js";
import { TENANT } from "../core/config.js";
import { logger } from "../infra/logger.js";
import { esc } from "../tools/jobhunt/telegram-format.js";
import { firstSentence, toolLabel, loadCapabilityRegistry, type CapabilityRegistry } from "./capabilities-screen.js";

const log = logger.child({ module: "capability-hint" });

export const HINT_ACTION = "capability_hint";

/** Never advertised: raw shell access is not a feature to nudge him toward. */
const NEVER_SUGGEST: ReadonlySet<string> = new Set(["run_shell", "vps_run"]);

export interface HintPick {
  tool: string;
  department: string;
  description: string;
}

export function pickHint(input: {
  registry: CapabilityRegistry;
  departments: readonly string[];
  used: ReadonlySet<string>;
  hinted: ReadonlySet<string>;
}): HintPick | null {
  for (const department of input.departments) {
    for (const t of input.registry.departments[department] ?? []) {
      if (NEVER_SUGGEST.has(t.name) || input.used.has(t.name) || input.hinted.has(t.name)) continue;
      if (!t.description?.trim() || !input.registry.isAvailable(t.name)) continue;
      return { tool: t.name, department, description: t.description };
    }
  }
  return null;
}

export function hintText(pick: HintPick, gated: boolean): string {
  return (
    `💡 <b>You can also ask me to:</b> ${esc(toolLabel(pick.tool))} — ${esc(firstSentence(pick.description))}` +
    `${gated ? " <i>(asks first)</i>" : ""}\n<i>Just say it in plain words.</i>`
  );
}

export function hintDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface HintDeps {
  registry: () => Promise<CapabilityRegistry>;
  hintedBefore: () => Promise<Set<string>>;
  /** True only for the first claim of the day. */
  claimToday: (tool: string, department: string, day: string) => Promise<boolean>;
  now: () => Date;
}

export const realHintDeps: HintDeps = {
  registry: loadCapabilityRegistry,
  hintedBefore: async () => {
    const rows = await getDb()
      .select({ payload: actionLog.payload })
      .from(actionLog)
      .where(and(eq(actionLog.tenant_id, TENANT), eq(actionLog.action, HINT_ACTION)));
    return new Set(rows.map((r) => (r.payload as { tool?: string } | null)?.tool).filter((t): t is string => !!t));
  },
  claimToday: async (tool, department, day) =>
    (
      await writeAuditEntry({
        tenant_id: TENANT,
        action: HINT_ACTION,
        idempotency_key: `${HINT_ACTION}:${TENANT}:${day}`,
        payload: { tool, department },
      })
    ).written,
  now: () => new Date(),
};

export interface HintTurn {
  /** Workers the plan used, in plan order. */
  departments: readonly string[];
  /** Tools already called this turn. */
  used: readonly string[];
  ok: boolean;
}

/** Sends at most one hint; never throws into the reply path. */
export async function maybeSendHint(
  turn: HintTurn,
  send: (html: string) => Promise<void>,
  deps: HintDeps = realHintDeps,
): Promise<void> {
  if (!turn.ok || turn.departments.length === 0) return;
  try {
    const registry = await deps.registry();
    const pick = pickHint({
      registry,
      departments: [...new Set(turn.departments)],
      used: new Set(turn.used),
      hinted: await deps.hintedBefore(),
    });
    if (!pick) return;
    if (!(await deps.claimToday(pick.tool, pick.department, hintDayKey(deps.now())))) return;
    await send(hintText(pick, registry.gated.has(pick.tool)));
  } catch (err) {
    // allow-failopen: a hint is a courtesy after the reply; losing it must never fail the turn
    log.warn({ err: String(err) }, "Capability hint skipped");
  }
}

/** The slice of the kernel's final state the hint needs; structural so tests need no graph. */
export interface HintableState {
  mission?: { plan?: { steps?: ReadonlyArray<{ worker: string }> } | null };
  results?: ReadonlyArray<{ tool_receipts?: ReadonlyArray<{ tool: string }> }>;
  failure?: unknown;
}

export function hintTurnFrom(state: HintableState): HintTurn {
  return {
    departments: (state.mission?.plan?.steps ?? []).map((s) => s.worker),
    used: (state.results ?? []).flatMap((r) => (r.tool_receipts ?? []).map((t) => t.tool)),
    ok: !state.failure,
  };
}

/** After a clean reply: the day's one hint, as its own message. */
export async function sendCapabilityHint(ctx: Context, state: HintableState): Promise<void> {
  await maybeSendHint(hintTurnFrom(state), async (html) => {
    await ctx.reply(html, { parse_mode: "HTML" });
  });
}
