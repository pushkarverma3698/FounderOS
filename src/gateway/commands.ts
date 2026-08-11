/**
 * FounderOS v3 — /command handlers (essential set).
 * ==================================================
 * The v2 command surface (20 commands: outbound, proofdrop, miso, workflows,
 * signals, targets, …) died with the old orchestration layers in the v3 kill
 * order. What remains is the operational minimum; new commands return only
 * when a kernel-backed feature needs them.
 */

import type { Context } from "grammy";
import { logger } from "../infra/logger.js";
import { getSystemStatus, formatStatusMessage } from "./status.js";
import { cancelPendingApprovals, getTodayCostUsd, getCostBreakdown } from "../db/queries.js";
import { clearThreadCheckpoints } from "../infra/checkpointer.js";
import { engageHalt, releaseHalt, readHalt } from "../infra/halt.js";
import { buildWelcomeMessage } from "./capability-message.js";
import { safeHtml } from "./approval-card.js";
import { TENANT, DAILY_BUDGET_USD, MCP_BRIDGE_ENABLED, MCP_BRIDGE_MANIFEST } from "../core/config.js";
import { assessDailyBudget, formatBudgetDashboard, getRunBudgetCaps } from "../infra/daily-budget.js";
import { WORKERS } from "../kernel/contracts.js";
import { searchRegistry, toManifestEntry, type RegistrySuggestion } from "../mcp/registry.js";
import { addServerToManifest, type AddResult } from "../mcp/manifest-store.js";
import type { McpServerEntry } from "../mcp/bridge-manifest.js";

const log = logger.child({ module: "commands" });

function threadIdFor(chatId: number | string): string {
  return `${TENANT}:${chatId}`;
}

export async function handleStart(ctx: Context): Promise<void> {
  await ctx.reply(buildWelcomeMessage(ctx.from?.first_name), { parse_mode: "HTML" });
}

/** /reset — explicit founder-initiated thread reset (the ONLY thread wipe in v3). */
export async function handleReset(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id ?? "unknown";
  const threadId = threadIdFor(chatId);
  try {
    await cancelPendingApprovals(threadId);
    await clearThreadCheckpoints(threadId);
    log.info({ chatId }, "Thread reset by founder");
    await ctx.reply("🧹 Thread reset — mission state and pending approvals cleared. Fresh start.");
  } catch (err) {
    await ctx.reply(`❌ Reset failed: ${safeHtml((err as Error).message)}`, { parse_mode: "HTML" });
  }
}

export async function handleStatus(ctx: Context): Promise<void> {
  try {
    const status = await getSystemStatus();
    await ctx.reply(formatStatusMessage(status), { parse_mode: "HTML" });
  } catch (err) {
    await ctx.reply(`❌ Status failed: ${safeHtml((err as Error).message)}`, { parse_mode: "HTML" });
  }
}

export async function handleBudget(ctx: Context): Promise<void> {
  try {
    const [todayUsd, breakdown] = await Promise.all([
      getTodayCostUsd(TENANT),
      getCostBreakdown(TENANT, 7).catch((err) => {
        log.warn({ err: (err as Error).message }, "/budget: breakdown query failed");
        return [];
      }),
    ]);
    const status = assessDailyBudget(todayUsd, DAILY_BUDGET_USD);
    await ctx.reply(formatBudgetDashboard(status, getRunBudgetCaps(), breakdown), { parse_mode: "HTML" });
  } catch (err) {
    log.error({ err: (err as Error).message }, "/budget failed");
    await ctx.reply(`❌ Could not load budget: ${safeHtml((err as Error).message)}`, { parse_mode: "HTML" });
  }
}

export async function handleHalt(ctx: Context): Promise<void> {
  await engageHalt("founder /halt");
  await ctx.reply("🛑 <b>Halted.</b> All new turns are refused until /resume.", { parse_mode: "HTML" });
}

export async function handleResume(ctx: Context): Promise<void> {
  if (!(await readHalt())) {
    await ctx.reply("Not halted — nothing to resume.");
    return;
  }
  await releaseHalt();
  await ctx.reply("▶️ Resumed — the kernel accepts turns again.");
}

export async function handleCommands(ctx: Context): Promise<void> {
  await ctx.reply(
    [
      "<b>Commands</b>",
      "/status — system health + pending approvals",
      "/budget — today's spend vs the daily cap",
      "/connect — search &amp; add an MCP server from the registry",
      "/reset — clear this thread's mission state",
      "/halt · /resume — emergency stop / restart",
      "",
      "<b>From the daily job brief</b>",
      "/draft &lt;n&gt; — write the application for row n of DO TODAY or A STRETCH WORTH APPLYING TO",
      "/ask &lt;n&gt; — write the question that unblocks row n of ONE QUESTION AWAY",
      "",
      "Everything else is natural language — the planner routes it.",
    ].join("\n"),
    { parse_mode: "HTML" },
  );
}

// ── /connect — registry discovery + install (ADR-041 Tier 3) ─────────────────

/** Injectable seams so the command logic is unit-tested without a live bot. */
export interface ConnectDeps {
  search(query: string): Promise<RegistrySuggestion[]>;
  addToManifest(key: string, entry: McpServerEntry): AddResult;
  reload(): Promise<void>;
  bridgeEnabled: boolean;
  envHas(name: string): boolean;
}

/** Pick the best match to install for `term` — a runnable candidate, preferring
 *  an exact name/key hit, else the first runnable, else the first (to explain
 *  why it can't be wired). */
function selectBest(suggestions: RegistrySuggestion[], term: string): RegistrySuggestion | undefined {
  const runnable = suggestions.filter((s) => s.proposed);
  return (
    runnable.find((s) => s.name === term) ??
    runnable.find((s) => s.key === term) ??
    runnable[0] ??
    suggestions[0]
  );
}

/**
 * Core /connect logic → the reply string. `add <name> <department>` installs a
 * server into the manifest and (when the bridge is on) reloads it live; a bare
 * query searches the registry and lists installable candidates.
 */
export async function runConnect(rawArgs: string, deps: ConnectDeps): Promise<string> {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);

  if (tokens[0]?.toLowerCase() === "add") {
    const term = tokens[1];
    const dept = tokens[2]?.toLowerCase();
    if (!term || !dept) return "Usage: <code>/connect add &lt;name&gt; &lt;department&gt;</code>";
    if (!(WORKERS as readonly string[]).includes(dept)) {
      return `Unknown department "${safeHtml(dept)}". Choose one of: ${WORKERS.join(", ")}.`;
    }

    let suggestions: RegistrySuggestion[];
    try {
      suggestions = await deps.search(term);
    } catch (err) {
      return `❌ Registry search failed: ${safeHtml((err as Error).message)}`;
    }
    const best = selectBest(suggestions, term);
    if (!best) return `No registry server matches "${safeHtml(term)}".`;
    if (!best.proposed) return `Can't auto-wire "${safeHtml(best.name)}": ${safeHtml(best.unsupported ?? "unsupported transport")}.`;

    const res = deps.addToManifest(best.key, toManifestEntry(best.proposed, dept));
    if (!res.added) return `⚠️ ${safeHtml(res.reason ?? "not added")}`;

    const lines = [`✅ Added <b>${safeHtml(best.key)}</b> → ${dept} (${best.proposed.transport}).`];
    const missing = best.requiredSecrets.filter((n) => !deps.envHas(n));
    if (missing.length) lines.push(`🔑 Set env var(s) then restart: <code>${missing.map(safeHtml).join(", ")}</code>`);

    if (!deps.bridgeEnabled) {
      lines.push("⚠️ MCP bridge is off — set <code>MCP_BRIDGE_ENABLED=true</code> and restart to activate.");
    } else if (missing.length) {
      lines.push("Tools will load once the secret(s) are set and the bot restarts.");
    } else {
      try {
        await deps.reload();
        lines.push("🔌 Bridge reloaded — its tools are live now (writes stay founder-approved).");
      } catch (err) {
        lines.push(`Saved, but live reload failed (${safeHtml((err as Error).message)}); a restart will pick it up.`);
      }
    }
    return lines.join("\n");
  }

  const query = rawArgs.trim();
  if (!query) {
    return [
      "<b>/connect</b> — add an MCP server from the official registry.",
      "Search:  <code>/connect &lt;query&gt;</code>  (e.g. <code>/connect notion</code>)",
      "Install: <code>/connect add &lt;name&gt; &lt;department&gt;</code>",
      `Departments: ${WORKERS.join(", ")}`,
    ].join("\n");
  }

  let suggestions: RegistrySuggestion[];
  try {
    suggestions = await deps.search(query);
  } catch (err) {
    return `❌ Registry search failed: ${safeHtml((err as Error).message)}`;
  }
  if (suggestions.length === 0) return `No registry servers found for "${safeHtml(query)}".`;

  const rows = suggestions.map((s) => {
    const tag = s.proposed ? s.proposed.transport : `⚠️ ${safeHtml(s.unsupported ?? "unsupported")}`;
    const desc = s.description ? ` — ${safeHtml(s.description.slice(0, 90))}` : "";
    return `• <b>${safeHtml(s.key)}</b> [${tag}]${desc}\n   <code>/connect add ${safeHtml(s.key)} &lt;department&gt;</code>`;
  });
  return [`<b>Registry matches for "${safeHtml(query)}"</b>`, ...rows].join("\n");
}

/** Real reload: reconnect the bridge and recompile the kernel so a newly added
 *  server's tools are live on the next turn. Dynamically imported so a flag-off
 *  build never loads the adapter or kernel graph here. */
async function reloadBridge(): Promise<void> {
  const { __resetBridgeCache } = await import("../mcp/client.js");
  const { resetKernelCache, getKernel } = await import("./kernel-boot.js");
  __resetBridgeCache();
  resetKernelCache();
  await getKernel(); // warm: reconnect + recompile so any failure surfaces now
}

export async function handleConnect(ctx: Context): Promise<void> {
  const rawArgs = (ctx.match as string) ?? "";
  try {
    const reply = await runConnect(rawArgs, {
      search: (q) => searchRegistry(q),
      addToManifest: (key, entry) => addServerToManifest(MCP_BRIDGE_MANIFEST, key, entry),
      reload: reloadBridge,
      bridgeEnabled: MCP_BRIDGE_ENABLED,
      envHas: (n) => process.env[n] !== undefined && process.env[n] !== "",
    });
    await ctx.reply(reply, { parse_mode: "HTML" });
  } catch (err) {
    log.error({ err: (err as Error).message }, "/connect failed");
    await ctx.reply(`❌ /connect failed: ${safeHtml((err as Error).message)}`, { parse_mode: "HTML" });
  }
}

/**
 * What to say when the founder types a slash command that does not exist.
 *
 * Silence was the old behaviour and it is the one unacceptable answer: the brief
 * hands out "/draft 1", and before those commands existed that tap produced no
 * reply, no error and no log the founder could see.
 */
export function unknownCommandReply(text: string): string {
  const typed = text.trim().split(/\s+/)[0] ?? "/";
  return (
    `${typed} isn't a command I know.\n\n` +
    "Try /commands for the list, or just say what you want in plain English — " +
    "the planner routes it."
  );
}
