/**
 * FounderOS v2 — Telegram Command Handlers
 * ==========================================
 * Pure command handler functions extracted from telegram.ts.
 * Each handler accepts a grammy Context (and any shared dependencies as
 * closure captures) and returns Promise<void>.
 *
 * Registration (bot.command(...)) stays in telegram.ts — this module
 * only contains the handler logic so telegram.ts stays focused on the
 * bot lifecycle and message routing.
 */

import type { Context } from "grammy";
import { logger } from "../infra/logger.js";
import {
  getOutboundTargets,
  addOutboundTargets,
  removeOutboundTarget,
  clearOutboundTargets,
} from "../outbound/targets.js";
import { buildBatchPrompt, splitBatch, parseCompanyArgs } from "../outbound/batch.js";
import {
  getProofDropStats,
  recordProofDrop,
  formatProofDropStats,
  normalizeProofDropCompany,
} from "../outbound/proof-drop.js";
import { getSystemStatus, formatRichStatus } from "./status.js";
import { parseContextCommand, formatContextDisplay } from "./context-command.js";
import { getFounderContext, upsertFounderContext, getActivitySummary, getLastEpisodicEvent, cancelPendingApprovals, countPendingDeptSignals, listPendingDeptSignals, getRecentLlmCosts, getTodayCostUsd, getCostBreakdown } from "../db/queries.js";
import { clearThreadCheckpoints } from "../infra/checkpointer.js";
import { engageHalt, releaseHalt, readHalt } from "../infra/halt.js";
import { getWorkflow, listWorkflows, parseRunArgs } from "../workflows/registry.js";
import { runWorkflow, validateParams } from "../workflows/runner.js";
import { formatSignalsMessage, formatRunsMessage, parseRunsLimit } from "./pipeline-format.js";
import { formatProviderStatusLine, getLastProviderProbe } from "../infra/provider-probes.js";
import { buildWelcomeMessage } from "./capability-message.js";
import {
  createMission,
  getActiveMission,
  getMissionById,
  getRecentAuditEntries,
} from "../db/queries.js";
import { formatMisoDashboard, formatMisoPlan, formatMisoClose, missionToView } from "./mission-control.js";
import { postMissionDashboard } from "./mission-sync.js";
import { buildMisoStatus, closeActiveMission } from "./web.js";
import { TENANT as CONFIG_TENANT, DAILY_BUDGET_USD } from "../core/config.js";
import {
  assessDailyBudget,
  formatBudgetDashboard,
  formatBudgetStatusLine,
  getRunBudgetCaps,
} from "../infra/daily-budget.js";

/** Escape special HTML characters for Telegram HTML parse mode. */
function safeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const log = logger.child({ module: "commands" });

const TENANT = process.env["FOUNDER_TENANT"] ?? "turicks";

/** Build the stable per-chat thread ID (must match telegram.ts). */
function threadIdFor(chatId: number | string): string {
  return `${TENANT}:${chatId}`;
}

// ── /start ─────────────────────────────────────────────────────────────────────

export async function handleStart(ctx: Context): Promise<void> {
  const name = ctx.from?.first_name;
  await ctx.reply(buildWelcomeMessage(name), { parse_mode: "HTML" });
}

// ── /help — alias for /commands ───────────────────────────────────────────────

/** /help is a UX-friendly alias for /commands — same output, zero extra logic. */
export async function handleHelp(ctx: Context): Promise<void> {
  return handleCommands(ctx);
}

// ── /ping — instant health check ──────────────────────────────────────────────

/**
 * /ping responds immediately without routing through the office.
 * Shows bot liveness and round-trip latency from Telegram message timestamp.
 */
export async function handlePing(ctx: Context): Promise<void> {
  const latencyMs = Date.now() - (ctx.message?.date ?? 0) * 1000;
  await ctx.reply(`🟢 FounderOS alive · ${latencyMs}ms`);
}

// ── /reset ─────────────────────────────────────────────────────────────────────

export async function handleReset(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  try {
    const deleted = await clearThreadCheckpoints(threadIdFor(chatId));
    // G9: also cancel any ghost pending HITL approval rows so the daily
    // stale-approval reminder doesn't nag about a thread we just wiped.
    try {
      await cancelPendingApprovals(threadIdFor(chatId));
    } catch (err) {
      log.warn({ chatId, err: (err as Error).message }, "Cancel ghost approvals on /reset failed — non-fatal");
    }
    await ctx.reply(
      `🧹 <b>Conversation reset.</b> Cleared ${deleted} memory snapshot${deleted === 1 ? "" : "s"}.\n` +
        `The office now starts fresh — past turns won't influence new replies.`,
      { parse_mode: "HTML" },
    );
    log.info({ chatId, deleted }, "Thread reset via /reset command");
  } catch (err) {
    await ctx.reply(`❌ Reset failed: ${safeHtml((err as Error).message)}`, { parse_mode: "HTML" });
  }
}

// ── /halt — global kill switch ────────────────────────────────────────────────

/**
 * Why: the founder needs one instant command to stop FounderOS acting — before a
 * deploy, when something looks wrong, or to freeze all outbound work.
 * When: typed manually. Optional free-text reason after the command.
 * What: engages the global halt (src/infra/halt.ts). Every new turn AND every
 * pending-approval resume is then refused at the gateway until /resume. It does
 * NOT abort a task already mid-run (turns are seconds-long; the budget guard caps
 * runaway loops) — this is stated to the founder so the guarantee isn't overclaimed.
 */
export async function handleHalt(ctx: Context): Promise<void> {
  const reason = (ctx.message?.text ?? "").replace(/^\/halt(@\S+)?\s*/i, "").trim();
  try {
    const state = await engageHalt(reason || "manual halt", ctx.from?.first_name ?? "founder");
    await ctx.reply(
      `🛑 <b>FounderOS halted.</b>\n` +
        `Reason: <i>${safeHtml(state.reason)}</i>\n\n` +
        `All new tasks are now refused. Send <code>/resume</code> to re-enable.\n` +
        `<i>Note: a task already mid-run isn't interrupted — this blocks new turns.</i>`,
      { parse_mode: "HTML" },
    );
    log.warn({ chatId: ctx.chat?.id, reason: state.reason }, "Global halt engaged via /halt");
  } catch (err) {
    await ctx.reply(`❌ Could not engage halt: ${safeHtml((err as Error).message)}`, { parse_mode: "HTML" });
  }
}

// ── /resume — lift the kill switch ────────────────────────────────────────────

/**
 * Why: re-enable FounderOS after a /halt.
 * What: releases the global halt (idempotent). Reports whether it was actually
 * halted so a stray /resume gives honest feedback rather than a false "resumed".
 */
export async function handleResume(ctx: Context): Promise<void> {
  try {
    const wasHalted = (await readHalt()) !== null;
    await releaseHalt();
    await ctx.reply(
      wasHalted
        ? `✅ <b>FounderOS resumed.</b> Tasks will process normally again.`
        : `ℹ️ FounderOS wasn't halted — nothing to resume. (Tasks are running normally.)`,
      { parse_mode: "HTML" },
    );
    log.info({ chatId: ctx.chat?.id, wasHalted }, "Global halt released via /resume");
  } catch (err) {
    await ctx.reply(`❌ Could not resume: ${safeHtml((err as Error).message)}`, { parse_mode: "HTML" });
  }
}

// ── /status ─────────────────────────────────────────────────────────────────────

export async function handleStatus(ctx: Context): Promise<void> {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Fetch all data in parallel; each query has its own fallback
    const [systemData, founderCtx, activity, lastEvent, outboundTargets, pendingSignals, todayUsd] = await Promise.all([
      getSystemStatus(),
      getFounderContext(TENANT).catch(() => ({} as Record<string, unknown>)),
      getActivitySummary(TENANT, todayStart).catch(() => ({} as Record<string, number>)),
      getLastEpisodicEvent(TENANT).catch(() => null),
      getOutboundTargets(TENANT).catch(() => [] as string[]),
      countPendingDeptSignals(TENANT).catch(() => 0),
      getTodayCostUsd(TENANT).catch(() => 0),
    ]);

    const activeClients = Array.isArray(founderCtx["active_clients"])
      ? (founderCtx["active_clients"] as string[])
      : [];
    const focus = typeof founderCtx["focus"] === "string" ? founderCtx["focus"] : null;

    // Relative time for last event
    let lastEventRelativeTime: string | null = null;
    if (lastEvent?.created_at) {
      const diffMs = Date.now() - lastEvent.created_at.getTime();
      const diffMins = Math.floor(diffMs / 60_000);
      if (diffMins < 60) lastEventRelativeTime = `${diffMins}m ago`;
      else if (diffMins < 1440) lastEventRelativeTime = `${Math.floor(diffMins / 60)}h ago`;
      else lastEventRelativeTime = `${Math.floor(diffMins / 1440)}d ago`;
    }

    const message = formatRichStatus({
      uptimeSeconds: systemData.uptimeSeconds,
      pendingApprovals: systemData.pendingApprovals,
      emailsSentToday: activity["send_email"] ?? activity["email_sent"] ?? systemData.emailsSentToday,
      searchesToday: activity["search_web"] ?? 0,
      calendarEventsToday: activity["create_calendar_event"] ?? 0,
      activeClients,
      focus,
      lastEventContent: lastEvent?.content ?? null,
      lastEventRelativeTime,
      outboundTargetCount: outboundTargets.length,
      pendingSignals,
      providerStatusLine: formatProviderStatusLine(getLastProviderProbe()),
      budgetStatusLine: formatBudgetStatusLine(assessDailyBudget(todayUsd, DAILY_BUDGET_USD)),
    });

    await ctx.reply(message, { parse_mode: "HTML" });
  } catch (err) {
    await ctx.reply(`❌ Status check failed: ${safeHtml((err as Error).message)}`, { parse_mode: "HTML" });
  }
}

// ── /context ───────────────────────────────────────────────────────────────────

export async function handleContext(ctx: Context): Promise<void> {
  const arg = (ctx.match ?? "").toString().trim();
  const parsed = parseContextCommand(arg);

  if (parsed.action === "error") {
    await ctx.reply(`❌ ${safeHtml(parsed.message)}`, { parse_mode: "HTML" });
    return;
  }

  if (parsed.action === "show") {
    const storedCtx = await getFounderContext(TENANT);
    await ctx.reply(formatContextDisplay(storedCtx), { parse_mode: "HTML" });
    return;
  }

  // action === "set"
  const { key, value } = parsed;
  const listKeys = new Set(["active_clients", "current_priorities", "open_deals", "next_actions"]);
  const update: Record<string, unknown> = listKeys.has(key)
    ? { [key]: value.split(",").map((v) => v.trim()).filter(Boolean) }
    : { [key]: value };

  await upsertFounderContext(TENANT, update);
  await ctx.reply(`✅ Context updated: <b>${safeHtml(key)}</b> → <i>${safeHtml(value)}</i>`, {
    parse_mode: "HTML",
  });
  log.info({ key, value }, "Founder context updated via /context command");
}

// ── /target ────────────────────────────────────────────────────────────────────

export async function handleTarget(ctx: Context): Promise<void> {
  const arg = (ctx.match ?? "").toString().trim();
  if (!arg) {
    await ctx.reply("Usage: <code>/target Acme Corp, Beta Ltd</code>", { parse_mode: "HTML" });
    return;
  }
  const { added, targets } = await addOutboundTargets(TENANT, parseCompanyArgs(arg));
  const msg =
    added.length > 0
      ? `🎯 Added: ${safeHtml(added.join(", "))}\nList now has <b>${targets.length}</b> target${targets.length === 1 ? "" : "s"}.`
      : `Nothing new to add (already on the list). List has <b>${targets.length}</b> target${targets.length === 1 ? "" : "s"}.`;
  await ctx.reply(msg, { parse_mode: "HTML" });
}

// ── /targets ───────────────────────────────────────────────────────────────────

export async function handleTargets(ctx: Context): Promise<void> {
  const arg = (ctx.match ?? "").toString().trim().toLowerCase();
  if (arg === "clear") {
    await clearOutboundTargets(TENANT);
    await ctx.reply("🧹 Outbound target list cleared.");
    return;
  }
  const targets = await getOutboundTargets(TENANT);
  if (targets.length === 0) {
    await ctx.reply("No outbound targets yet. Add some: <code>/target Acme Corp</code>", { parse_mode: "HTML" });
    return;
  }
  const list = targets.map((t, i) => `${i + 1}. ${safeHtml(t)}`).join("\n");
  await ctx.reply(`🎯 <b>Outbound targets (${targets.length})</b>\n${list}\n\nScore them: <code>/outbound</code>`, {
    parse_mode: "HTML",
  });
}

// ── /untarget ──────────────────────────────────────────────────────────────────

export async function handleUntarget(ctx: Context): Promise<void> {
  const arg = (ctx.match ?? "").toString().trim();
  if (!arg) {
    await ctx.reply("Usage: <code>/untarget Acme Corp</code>", { parse_mode: "HTML" });
    return;
  }
  const { removed, targets } = await removeOutboundTarget(TENANT, arg);
  await ctx.reply(
    removed
      ? `✅ Removed ${safeHtml(arg)}. ${targets.length} target${targets.length === 1 ? "" : "s"} left.`
      : `"${safeHtml(arg)}" wasn't on the list.`,
    { parse_mode: "HTML" },
  );
}

// ── /outbound — needs runOfficeText injected to avoid circular import ──────────

export async function handleOutbound(
  ctx: Context,
  runOfficeText: (ctx: Context, text: string) => Promise<void>,
): Promise<void> {
  const arg = (ctx.match ?? "").toString().trim();
  const targets = arg ? parseCompanyArgs(arg) : await getOutboundTargets(TENANT);

  if (targets.length === 0) {
    await ctx.reply(
      "No targets to score. Add some with <code>/target Acme Corp</code>, then <code>/outbound</code> — or score ad-hoc: <code>/outbound stripe.com</code>.",
      { parse_mode: "HTML" },
    );
    return;
  }

  const { batch, overflow } = splitBatch(targets);
  if (overflow.length > 0) {
    await ctx.reply(
      `🎯 Scoring the first <b>${batch.length}</b> of ${targets.length}. Run <code>/outbound</code> again later for the remaining ${overflow.length}.`,
      { parse_mode: "HTML" },
    );
  }
  await runOfficeText(ctx, buildBatchPrompt(batch));
}

// ── /proofdrop — Phase D-Bis Proof Drop workflow shortcut ─────────────────────

export async function handleProofDrop(
  ctx: Context,
  runOfficeText: (ctx: Context, text: string) => Promise<void>,
): Promise<void> {
  const arg = (ctx.match ?? "").toString().trim();

  if (!arg) {
    const stats = await getProofDropStats(TENANT);
    await ctx.reply(
      `🎁 <b>Proof Drop Pipeline</b> (Phase D-Bis GTM)\n\n` +
        `${formatProofDropStats(stats)}\n\n` +
        `<b>Usage:</b> <code>/proofdrop CompanyName</code>\n` +
        `Example: <code>/proofdrop Linear</code>\n\n` +
        `Flow: ICP gate → research → artifact concept → outreach draft (HITL ✋)\n` +
        `Target: ${stats.target}/week high-craft drops.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const company = normalizeProofDropCompany(arg);
  if (!company) {
    await ctx.reply("❌ Invalid company name. Example: <code>/proofdrop Linear</code>", {
      parse_mode: "HTML",
    });
    return;
  }

  const wf = getWorkflow("proof_drop");
  if (!wf) {
    await ctx.reply("❌ Proof Drop workflow not registered.", { parse_mode: "HTML" });
    return;
  }

  const result = await runWorkflow(wf, { company }, {
    async sendStatus(msg) {
      await ctx.reply(msg, { parse_mode: "HTML" });
    },
    async runStep(task) {
      try {
        await runOfficeText(ctx, task);
        return true;
      } catch {
        return false;
      }
    },
  });

  if (result.completed) {
    const stats = await recordProofDrop(TENANT, company);
    await ctx.reply(
      `🎁 Proof Drop logged for <b>${safeHtml(company)}</b>.\n${formatProofDropStats(stats)}`,
      { parse_mode: "HTML" },
    );
    log.info({ company, stepsRun: result.stepsRun }, "Proof Drop workflow completed");
  }
}

// ── /commands ─────────────────────────────────────────────────────────────────

export async function handleCommands(ctx: Context): Promise<void> {
  await ctx.reply(
    `📋 <b>FounderOS — All Commands</b>\n\n` +

    `<b>💬 General</b>\n` +
    `<code>/start</code> — welcome message + quick-start guide\n` +
    `<code>/commands</code> — this list\n` +
    `<code>/departments</code> — what each department does\n` +
    `<code>/status</code> — uptime, pending approvals, pipeline + activity today\n` +
    `<code>/reset</code> — wipe this chat's memory (start a fresh conversation)\n` +
    `<code>/halt [reason]</code> — 🛑 kill switch: refuse all new tasks until /resume\n` +
    `<code>/resume</code> — lift the halt and process tasks normally again\n\n` +

    `<b>📋 Context</b>\n` +
    `<code>/context</code> — view your stored business context (clients, priorities)\n` +
    `<code>/context set &lt;key&gt; &lt;value&gt;</code> — update a key\n` +
    `  Valid keys: <code>active_clients</code> · <code>current_priorities</code> · <code>open_deals</code> · <code>next_actions</code> · <code>focus</code>\n` +
    `  Example: <code>/context set active_clients Acme, Beta Ltd</code>\n\n` +

    `<b>🎯 Outbound</b>\n` +
    `<code>/target &lt;company&gt;</code> — add prospect(s) to this week's list (comma-separated)\n` +
    `<code>/targets</code> — show the current prospect list\n` +
    `<code>/targets clear</code> — empty the list\n` +
    `<code>/untarget &lt;company&gt;</code> — remove a specific prospect\n` +
    `<code>/outbound</code> — ICP-score the whole list (no approval needed)\n` +
    `<code>/outbound &lt;company&gt;</code> — score a single company ad-hoc\n` +
    `<code>/proofdrop &lt;company&gt;</code> — 🎁 Proof Drop: research → artifact → outreach (HITL ✋)\n\n` +

    `<b>🏭 Workflows — run a company SOP in one command</b>\n` +
    `<code>/workflows</code> — list all available procedures\n` +
    `<code>/run onboarding company=Acme</code> — score → research → welcome email → GitHub repo\n` +
    `<code>/run outbound company=Stripe</code> — score → find hook → cold email\n` +
    `<code>/run proof_drop company=Linear</code> — 🎁 research → artifact concept → Proof Drop email\n` +
    `<code>/run weekly_digest</code> — review memory + open items + Monday plan\n\n` +

    `<b>⚡ Power-user direct routing</b>\n` +
    `<code>/q &lt;dept&gt; &lt;task&gt;</code> — skip supervisor, go straight to a department\n` +
    `  Example: <code>/q research what does Anthropic do?</code>\n` +
    `  Departments: research · comms · engineering · marketing · sales · personal · jobhunt\n` +
    `<code>/signals</code> — list pending cross-department signals (read-only)\n` +
    `<code>/budget</code> — daily spend vs cap + 7-day breakdown\n` +
    `<code>/runs [n]</code> — last n LLM calls + today's spend (default 10, max 25)\n\n` +

    `<b>🤖 MISO Mission Control</b>\n` +
    `<code>/miso_start &lt;goal&gt;</code> — open a mission dashboard\n` +
    `<code>/miso_plan</code> — show execution plan for active mission\n` +
    `<code>/miso_status</code> — mission phase + pending HITL\n` +
    `<code>/miso_close</code> — close active mission with summary\n\n` +

    `<b>🔒 Approval-gated actions</b> (bot asks before sending)\n` +
    `<i>"Email alex@acme.com about X"</i> → approval card → ✅/❌\n` +
    `<i>"Post to LinkedIn about X"</i> → approval card → ✅/❌\n` +
    `<i>"Create a GitHub issue on X"</i> → approval card → ✅/❌\n\n` +

    `<b>📖 Free-text triggers (no command needed)</b>\n` +
    `<i>"Research what Stripe does"</i>\n` +
    `<i>"Check my unread emails"</i>\n` +
    `<i>"Score Acme Corp as a Turicks prospect"</i>\n` +
    `<i>"Draft a LinkedIn post about AI automation"</i>`,
    { parse_mode: "HTML" },
  );
}

// ── /departments ───────────────────────────────────────────────────────────────

export async function handleDepartments(ctx: Context): Promise<void> {
  await ctx.reply(
    `🏢 <b>FounderOS — Departments</b>\n\n` +

    `<b>🔍 Research</b>\n` +
    `Web search + knowledge base lookup + email inbox read\n` +
    `Tools: <code>search_web</code> · <code>search_knowledge</code> · <code>read_emails</code>\n` +
    `Triggers: "Research X", "What does Y do?", "Check my inbox"\n\n` +

    `<b>📨 Comms</b>\n` +
    `Email and LinkedIn comms — all writes are HITL-gated\n` +
    `Tools: <code>send_email</code>✋ · <code>read_emails</code> · <code>linkedin_post</code>✋\n` +
    `Triggers: "Email X about Y", "Reply to...", "Message..."\n\n` +

    `<b>⚙️ Engineering</b>\n` +
    `GitHub read/write — pushes are HITL-gated\n` +
    `Tools: <code>github_read</code> · <code>github_write</code>✋\n` +
    `Triggers: "List my repos", "Create an issue on...", "Update README"\n\n` +

    `<b>📣 Marketing</b>\n` +
    `LinkedIn content in Turicks brand voice — posts are HITL-gated\n` +
    `Tools: <code>search_web</code> · <code>linkedin_post</code>✋ · <code>search_knowledge</code>\n` +
    `Triggers: "Draft a LinkedIn post about X", "Write content for..."\n\n` +

    `<b>📈 Sales</b>\n` +
    `Cold outreach drafting — emails are HITL-gated, ≤150 words\n` +
    `Tools: <code>search_web</code> · <code>send_email</code>✋ · <code>search_knowledge</code>\n` +
    `Triggers: "Draft outreach to Acme", "Write a cold email to..."\n\n` +

    `<b>🎯 Prospecting</b>\n` +
    `ICP scoring (1-10) — research only, no writes\n` +
    `Tools: <code>search_web</code> · <code>search_knowledge</code>\n` +
    `Triggers: "Score Acme as a prospect", "/outbound"\n\n` +

    `✋ = requires your approval before action executes`,
    { parse_mode: "HTML" },
  );
}

// ── /workflows — list available SOPs ──────────────────────────────────────────

export async function handleWorkflows(ctx: Context): Promise<void> {
  const workflows = listWorkflows();
  const lines = workflows.map((wf) => {
    const paramStr = wf.params.length > 0
      ? wf.params.map((p) => `<code>${p}=…</code>`).join(" ")
      : "(no params)";
    return `<b>${wf.id}</b> — ${safeHtml(wf.description)}\n  Params: ${paramStr}\n  Steps: ${wf.steps.map((s) => s.label ?? s.id).join(" → ")}`;
  }).join("\n\n");

  await ctx.reply(
    `📋 <b>FounderOS — Workflows</b>\n\n${lines}\n\n` +
    `Run one: <code>/run onboarding company=Acme</code>`,
    { parse_mode: "HTML" },
  );
}

// ── /run — execute a workflow SOP ─────────────────────────────────────────────

export async function handleRun(
  ctx: Context,
  runOfficeText: (ctx: Context, text: string) => Promise<void>,
): Promise<void> {
  const arg = (ctx.match ?? "").toString().trim();

  if (!arg) {
    await ctx.reply(
      `Usage: <code>/run &lt;workflow&gt; [key=value ...]</code>\n\nExample:\n` +
      `<code>/run onboarding company=Acme Corp</code>\n` +
      `<code>/run outbound company=Stripe</code>\n\n` +
      `See all workflows: <code>/workflows</code>`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const parsed = parseRunArgs(arg);
  if (!parsed) {
    await ctx.reply(`❌ Could not parse: <code>${safeHtml(arg)}</code>`, { parse_mode: "HTML" });
    return;
  }

  const wf = getWorkflow(parsed.id);
  if (!wf) {
    const ids = listWorkflows().map((w) => `<code>${w.id}</code>`).join(" · ");
    await ctx.reply(
      `❌ Unknown workflow <b>${safeHtml(parsed.id)}</b>. Available: ${ids}`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const missing = validateParams(wf, parsed.params);
  if (missing.length > 0) {
    const needed = missing.map((p) => `<code>${p}=…</code>`).join(", ");
    await ctx.reply(
      `❌ Missing required params for <b>${wf.name}</b>: ${needed}\n\nExample: <code>/run ${wf.id} ${wf.params.map((p) => `${p}=value`).join(" ")}</code>`,
      { parse_mode: "HTML" },
    );
    return;
  }

  await runWorkflow(wf, parsed.params, {
    async sendStatus(msg) {
      await ctx.reply(msg, { parse_mode: "HTML" });
    },
    async runStep(task) {
      try {
        await runOfficeText(ctx, task);
        return true;
      } catch {
        return false;
      }
    },
  });
}

// ── /q — direct-to-department bypass ─────────────────────────────────────────
// Power-user shortcut: skip the supervisor and send a task directly to a named
// department. The routing hint is injected as a prefix — still goes through
// the office, but the supervisor prompt will force-route it.

export async function handleQ(
  ctx: Context,
  runOfficeText: (ctx: Context, text: string) => Promise<void>,
): Promise<void> {
  const arg = (ctx.match ?? "").toString().trim();
  if (!arg) {
    await ctx.reply(
      `Usage: <code>/q &lt;department&gt; &lt;task&gt;</code>\n\nExample:\n` +
      `<code>/q research what does Stripe do?</code>\n` +
      `<code>/q engineering write a TypeScript debounce function</code>\n` +
      `<code>/q personal list files on my Desktop</code>`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const spaceIdx = arg.indexOf(" ");
  if (spaceIdx === -1) {
    await ctx.reply(`❌ Missing task after department name.`, { parse_mode: "HTML" });
    return;
  }

  const dept = arg.slice(0, spaceIdx).toLowerCase();
  const task = arg.slice(spaceIdx + 1).trim();

  const validDepts = ["research", "comms", "engineering", "marketing", "sales", "personal", "jobhunt"];
  if (!validDepts.includes(dept)) {
    await ctx.reply(
      `❌ Unknown department <b>${safeHtml(dept)}</b>.\nAvailable: ${validDepts.map((d) => `<code>${d}</code>`).join(" · ")}`,
      { parse_mode: "HTML" },
    );
    return;
  }

  // Inject routing hint into the task — the supervisor prompt forces exact routing
  const routed = `[Route directly to ${dept} department]: ${task}`;
  log.info({ dept, task: task.slice(0, 80) }, "/q direct-to-dept");
  await runOfficeText(ctx, routed);
}

// ── /signals — pending dept_signals (read-only) ───────────────────────────────

export async function handleSignals(ctx: Context): Promise<void> {
  try {
    const signals = await listPendingDeptSignals(TENANT, 20);
    await ctx.reply(formatSignalsMessage(signals), { parse_mode: "HTML" });
  } catch (err) {
    log.error({ err: (err as Error).message }, "/signals failed");
    await ctx.reply(`❌ Could not load signals: ${safeHtml((err as Error).message)}`, { parse_mode: "HTML" });
  }
}

// ── /budget — daily + per-run spend dashboard ───────────────────────────────

export async function handleBudget(ctx: Context): Promise<void> {
  try {
    const [todayUsd, breakdown] = await Promise.all([
      getTodayCostUsd(TENANT),
      getCostBreakdown(TENANT, 7).catch(() => []),
    ]);
    const status = assessDailyBudget(todayUsd, DAILY_BUDGET_USD);
    const message = formatBudgetDashboard(status, getRunBudgetCaps(), breakdown);
    await ctx.reply(message, { parse_mode: "HTML" });
  } catch (err) {
    log.error({ err: (err as Error).message }, "/budget failed");
    await ctx.reply(`❌ Could not load budget: ${safeHtml((err as Error).message)}`, { parse_mode: "HTML" });
  }
}

// ── /runs — recent LLM cost digest ────────────────────────────────────────────

export async function handleRuns(ctx: Context): Promise<void> {
  try {
    const limit = parseRunsLimit((ctx.match ?? "").toString());
    const [todayUsd, calls] = await Promise.all([
      getTodayCostUsd(TENANT),
      getRecentLlmCosts(TENANT, limit),
    ]);
    await ctx.reply(formatRunsMessage(todayUsd, calls), { parse_mode: "HTML" });
  } catch (err) {
    log.error({ err: (err as Error).message }, "/runs failed");
    await ctx.reply(`❌ Could not load runs: ${safeHtml((err as Error).message)}`, { parse_mode: "HTML" });
  }
}

// ── MISO mission control ──────────────────────────────────────────────────────

export async function handleMisoStart(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const sessionId = String(chatId);
  const goal = (ctx.match ?? "").toString().trim();
  if (!goal) {
    await ctx.reply("Usage: <code>/miso_start &lt;goal&gt;</code>", { parse_mode: "HTML" });
    return;
  }

  const existing = await getActiveMission(sessionId);
  if (existing) {
    await ctx.reply(
      `⏸ Active mission already open:\n<pre>${safeHtml(formatMisoDashboard(missionToView(existing)))}</pre>\nUse /miso_close first.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const missionId = await createMission({
    tenant_id: CONFIG_TENANT,
    session_id: sessionId,
    thread_id: threadIdFor(chatId),
    goal,
    owner: ctx.from?.first_name ?? "founder",
    phase: "INIT",
    next_action: "send a task or /miso_plan",
  });

  await postMissionDashboard(sessionId, missionId);
  const row = await getMissionById(missionId);
  await ctx.reply(row ? formatMisoDashboard(missionToView(row)) : "Mission started.");
}

export async function handleMisoPlan(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const mission = await getActiveMission(String(chatId));
  if (!mission) {
    await ctx.reply("No active mission. Use <code>/miso_start &lt;goal&gt;</code>", { parse_mode: "HTML" });
    return;
  }
  await ctx.reply(formatMisoPlan(mission.goal));
}

export async function handleMisoStatus(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const text = await buildMisoStatus(String(chatId));
  await ctx.reply(text);
}

export async function handleMisoClose(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  const sessionId = String(chatId);
  const summary = await closeActiveMission(sessionId);
  if (!summary) {
    await ctx.reply("No active mission to close.");
    return;
  }
  const audit = await getRecentAuditEntries(CONFIG_TENANT, 3);
  const auditLine = audit.length > 0 ? `\nRecent audit: ${audit.map((a) => a.action).join(", ")}` : "";
  await ctx.reply(`${summary}${auditLine}`);
}
