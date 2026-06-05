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
import { getSystemStatus, formatRichStatus } from "./status.js";
import { parseContextCommand, formatContextDisplay } from "./context-command.js";
import { getFounderContext, upsertFounderContext, getActivitySummary, getLastEpisodicEvent } from "../db/queries.js";
import { clearThreadCheckpoints } from "../infra/checkpointer.js";
import { getWorkflow, listWorkflows, parseRunArgs } from "../workflows/registry.js";
import { runWorkflow, validateParams } from "../workflows/runner.js";

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
  const name = ctx.from?.first_name ? ` ${ctx.from.first_name}` : "";
  await ctx.reply(
    `👋 <b>FounderOS${name}</b> — your AI chief of staff is live.\n\n` +
      `Just tell me what you need. I route it to the right department:\n` +
      `• <b>Research</b> — <i>"Research Stripe and summarise what they do"</i>\n` +
      `• <b>Comms</b> — <i>"Email alex@acme.com a short intro"</i> (you approve before it sends)\n` +
      `• <b>Engineering</b> — <i>"Write a TS function to validate emails"</i> / <i>"Open a GitHub issue on …"</i>\n\n` +
      `🎯 <b>Weekly outbound</b>\n` +
      `• <code>/target Acme Corp, Beta Ltd</code> — add prospects to this week's list\n` +
      `• <code>/targets</code> — show the list (<code>/targets clear</code> to empty it)\n` +
      `• <code>/outbound</code> — ICP-score the list (or <code>/outbound stripe.com</code> ad-hoc)\n` +
      `  then <i>"draft outreach to &lt;winner&gt;"</i> to send (you approve first)\n\n` +
      `🏭 <b>Workflows (multi-step SOPs)</b>\n` +
      `• <code>/workflows</code> — list all available procedures\n` +
      `• <code>/run onboarding company=Acme</code> — score → research → email → repo\n` +
      `• <code>/run outbound company=Stripe</code> — score → hook → cold email\n\n` +
      `⚡ <b>Power-user</b>\n` +
      `• <code>/q research what does Anthropic do?</code> — direct to department\n\n` +
      `⚙️ <b>System</b>\n` +
      `• <code>/help</code> — full command list (same as /commands)\n` +
      `• <code>/ping</code> — check if the bot is alive + latency\n` +
      `• <code>/commands</code> — full command list\n` +
      `• <code>/departments</code> — what each department does\n` +
      `• <code>/status</code> — uptime, pending approvals, emails sent today\n` +
      `• <code>/context</code> — view/update your business context\n\n` +
      `🔒 Anything that leaves the building (email, LinkedIn, GitHub writes) asks for your approval first.`,
    { parse_mode: "HTML" },
  );
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

// ── /status ─────────────────────────────────────────────────────────────────────

export async function handleStatus(ctx: Context): Promise<void> {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Fetch all data in parallel; each query has its own fallback
    const [systemData, founderCtx, activity, lastEvent] = await Promise.all([
      getSystemStatus(),
      getFounderContext(TENANT).catch(() => ({} as Record<string, unknown>)),
      getActivitySummary(TENANT, todayStart).catch(() => ({} as Record<string, number>)),
      getLastEpisodicEvent(TENANT).catch(() => null),
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

// ── /commands ─────────────────────────────────────────────────────────────────

export async function handleCommands(ctx: Context): Promise<void> {
  await ctx.reply(
    `📋 <b>FounderOS — All Commands</b>\n\n` +

    `<b>💬 General</b>\n` +
    `<code>/start</code> — welcome message + quick-start guide\n` +
    `<code>/commands</code> — this list\n` +
    `<code>/departments</code> — what each department does\n` +
    `<code>/status</code> — uptime, pending approvals, emails sent today\n` +
    `<code>/reset</code> — wipe this chat's memory (start a fresh conversation)\n\n` +

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
    `<code>/outbound &lt;company&gt;</code> — score a single company ad-hoc\n\n` +

    `<b>🏭 Workflows — run a company SOP in one command</b>\n` +
    `<code>/workflows</code> — list all available procedures\n` +
    `<code>/run onboarding company=Acme</code> — score → research → welcome email → GitHub repo\n` +
    `<code>/run outbound company=Stripe</code> — score → find hook → cold email\n` +
    `<code>/run weekly_digest</code> — review memory + open items + Monday plan\n\n` +

    `<b>⚡ Power-user direct routing</b>\n` +
    `<code>/q &lt;dept&gt; &lt;task&gt;</code> — skip supervisor, go straight to a department\n` +
    `  Example: <code>/q research what does Anthropic do?</code>\n` +
    `  Departments: research · comms · engineering · marketing · sales · prospecting · personal · jobhunt\n\n` +

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

  const validDepts = ["research", "comms", "engineering", "marketing", "sales", "prospecting", "personal", "jobhunt"];
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
