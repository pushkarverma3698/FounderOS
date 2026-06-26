/**
 * FounderOS — Proactive Scheduler
 * =================================
 * node-cron jobs that push proactive messages to the founder's Telegram.
 *
 * Jobs:
 *  1. Monday 8:00am  — Weekly brief (context-driven, no LLM call)
 *  2. Daily 09:00am  — Stale approval reminder (HITL items > 12 hours old)
 *
 * The scheduler uses sendToChat() to push messages directly to TELEGRAM_CHAT_ID.
 * It does NOT invoke the office graph (no LLM cost for routine reminders).
 * The Monday brief IS LLM-generated (one model call per week — cheap).
 *
 * Architecture note: scheduler is started ONCE in index.ts after the office
 * compiles. It accesses the DB directly — no need to go through the graph.
 */

import cron from "node-cron";
import { spawn } from "node:child_process";
import { HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { getFounderContext, getPendingInterrupt, consumePendingEvents, getTodayCostUsd } from "../db/queries.js";
import type { DeptSignal } from "../db/schema.js";
import { DEFAULT_TARGET_DEPT } from "../agents/agent-tools/signals.js";
import { getOutboundTargets } from "../outbound/targets.js";
import { getProofDropStats, buildProofDropCadenceNudge } from "../outbound/proof-drop.js";
import { sendToChat } from "./telegram-send.js";
import { buildOffice } from "../agents/office.js";
import { SCHEDULER_BRIEF_PROMPT } from "../agents/system-prompts.js";
import { childLogger } from "./logger.js";
import { TENANT } from "../core/config.js";
import {
  assessDailyBudget,
  formatBudgetThresholdAlert,
  getDailyBudgetCapUsd,
  nextBudgetAlertThreshold,
  checkDailyBudgetGate,
} from "../infra/daily-budget.js";
import { getBudgetAlertsState, recordBudgetAlertSent } from "../infra/daily-budget-alerts.js";

const log = childLogger({ module: "scheduler" });

// Memoised office for scheduler use — compiled once, reused across Monday fires.
// A new MemorySaver is fine here (scheduler runs are one-shot, not resumed).
let _schedulerOffice: ReturnType<typeof buildOffice> | undefined;
function getSchedulerOffice(): ReturnType<typeof buildOffice> {
  _schedulerOffice ??= buildOffice(new MemorySaver());
  return _schedulerOffice;
}

// ── Monday brief ──────────────────────────────────────────────────────────────

/**
 * Build a concise context string for the LLM from the stored founder context.
 * Pure function — extracted for testability.
 */
export function buildContextText(ctx: Record<string, unknown>): string {
  const contextLines: string[] = [];
  for (const [key, value] of Object.entries(ctx)) {
    if (key === "last_updated") continue;
    const val = Array.isArray(value)
      ? (value as string[]).join(", ") || "none"
      : String(value || "none");
    contextLines.push(`${key}: ${val}`);
  }
  return contextLines.length > 0
    ? contextLines.join("\n")
    : "No context stored yet. Defaults:\nactive_clients: none\nopen_deals: none\ncurrent_priorities: review pipeline, post on LinkedIn, run outreach\nnext_actions: none";
}

/** Format the founder context into a monday brief (with an LLM call). */
async function sendMondayBrief(): Promise<void> {
  log.info("Generating Monday brief…");

  const spent = await getTodayCostUsd(TENANT);
  const dailyGate = checkDailyBudgetGate(spent, getDailyBudgetCapUsd());
  if (!dailyGate.ok) {
    log.warn({ spent }, "Monday brief skipped — daily budget cap reached");
    await sendToChat(
      `📅 <b>Monday brief skipped</b> — daily budget cap reached ($${spent.toFixed(4)}). ` +
        `Check <code>/budget</code>.`,
      "HTML",
    );
    return;
  }

  const ctx = await getFounderContext(TENANT);
  const today = new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const contextText = buildContextText(ctx);

  // Reuse the module-scoped memoised office (compiled once, never per Monday fire).
  const office = getSchedulerOffice();
  const config = { configurable: { thread_id: `${TENANT}:scheduler:monday` } };

  const prompt = `${SCHEDULER_BRIEF_PROMPT}\n\nToday is: ${today}\n\nFounder context:\n${contextText}`;

  if (!prompt || prompt.trim().length === 0) {
    log.error({}, "Scheduler prompt is empty, aborting");
    return;
  }

  // 5-minute hard timeout (P0 fix): node-cron is single-threaded; if this LLM
  // call hangs, ALL other jobs (hourly signal sweep, budget alerts) queue behind
  // it for the rest of the day. We abort unconditionally after 5 minutes so
  // the scheduler loop keeps running even on a Monday morning LLM outage.
  const BRIEF_TIMEOUT_MS = 5 * 60 * 1000;
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Monday brief LLM timed out (>5 min)")), BRIEF_TIMEOUT_MS),
  );
  const res = (await Promise.race([
    office.invoke({ messages: [new HumanMessage(prompt)] }, config),
    timeoutPromise,
  ])) as { messages: Array<{ content: unknown; _getType?: () => string; tool_calls?: unknown[] }> };

  // Extract last AI reply
  let brief = "📅 Monday Brief — no content generated.";
  for (let i = res.messages.length - 1; i >= 0; i--) {
    const m = res.messages[i]!;
    if (
      m._getType?.() === "ai" &&
      typeof m.content === "string" &&
      m.content.trim() &&
      !(m.tool_calls?.length)
    ) {
      brief = m.content.trim();
      break;
    }
  }

  await sendToChat(brief, "Markdown");
  log.info("Monday brief sent");
}

// ── Stale approval reminder ───────────────────────────────────────────────────

/** Check for HITL approvals pending > 12 hours and send a Telegram reminder. */
async function sendStaleApprovalReminder(): Promise<void> {
  // We can't directly query all threads without knowing the thread IDs.
  // Instead, query hitl_approvals directly for stale pending rows.
  // This is handled via the DB directly (not through getPendingInterrupt which requires thread_id).
  const { getDb } = await import("../db/client.js");
  const { hitlApprovals } = await import("../db/schema.js");
  const { and, eq, lt } = await import("drizzle-orm");

  const db = getDb();
  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);

  const stale = await db
    .select({
      thread_id: hitlApprovals.thread_id,
      callback_data: hitlApprovals.callback_data,
      created_at: hitlApprovals.created_at,
    })
    .from(hitlApprovals)
    .where(
      and(
        eq(hitlApprovals.status, "pending"),
        lt(hitlApprovals.created_at, twelveHoursAgo),
      ),
    );

  if (stale.length === 0) return;

  const lines = stale.map((row) => {
    const age = Math.round((Date.now() - (row.created_at?.getTime() ?? 0)) / 3_600_000);
    return `• Thread: \`${row.thread_id}\` — pending for ~${age}h`;
  });

  const msg =
    `⏰ <b>Pending approval reminder</b>\n\n` +
    `You have ${stale.length} approval${stale.length > 1 ? "s" : ""} waiting:\n${lines.join("\n")}\n\n` +
    `Send a message to the bot to resume that conversation.`;

  await sendToChat(msg, "HTML");
  log.info({ count: stale.length }, "Stale approval reminder sent");
}

// ── Weekly outbound nudge ─────────────────────────────────────────────────────

/** Monday nudge to run the weekly outbound batch (no LLM — reads founder_context). */
async function sendOutboundNudge(): Promise<void> {
  const targets = await getOutboundTargets(TENANT);
  const msg =
    targets.length > 0
      ? `🎯 <b>Outbound — new week</b>\n\nYou have <b>${targets.length}</b> target${targets.length === 1 ? "" : "s"} queued. Send <code>/outbound</code> to ICP-score them, then draft the winners.`
      : `🎯 <b>Outbound — new week</b>\n\nNo prospects queued yet. Add some as you spot them: <code>/target Acme Corp</code> — then <code>/outbound</code> Monday to score the batch.`;
  await sendToChat(msg, "HTML");
  log.info({ targets: targets.length }, "Outbound nudge sent");
}

// ── Revenue signal sweep (dept_signals consumer) ──────────────────────────────

/**
 * Format consumed lead_discovered signals into a proactive revenue nudge.
 * Pure — extracted for testability. The nudge SURFACES the lead; it never sends
 * outreach itself (the founder runs the HITL-gated send via the sales path).
 */
export function formatLeadNudge(signals: DeptSignal[]): string {
  const leads = signals.filter((s) => s.event_type === "lead_discovered");
  if (leads.length === 0) return "";

  const lines = leads.map((s) => {
    const p = (s.payload ?? {}) as {
      company?: string;
      icpScore?: number;
      contactName?: string;
      contactEmail?: string;
      source?: string;
    };
    const who = p.contactName ? ` — ${p.contactName}${p.contactEmail ? ` (${p.contactEmail})` : ""}` : "";
    const score = typeof p.icpScore === "number" ? ` · ICP ${p.icpScore}` : "";
    const src = p.source ? ` · via ${p.source}` : "";
    return `• <b>${p.company ?? "Unknown"}</b>${who}${score}${src}`;
  });

  return (
    `🎯 <b>New qualified lead${leads.length > 1 ? "s" : ""}</b> (${leads.length})\n\n` +
    `${lines.join("\n")}\n\n` +
    `Run outreach when ready: <code>/q sales draft cold outreach to {company}</code> — you approve before anything sends.`
  );
}

/** Format consumed proposal_approved signals for engineering. */
export function formatProposalNudge(signals: DeptSignal[]): string {
  const items = signals.filter((s) => s.event_type === "proposal_approved");
  if (items.length === 0) return "";

  const lines = items.map((s) => {
    const p = (s.payload ?? {}) as { company?: string; proposalId?: string; amountUsd?: number };
    const amt = typeof p.amountUsd === "number" ? ` · $${p.amountUsd}` : "";
    return `• <b>${p.company ?? "Unknown"}</b> — proposal ${p.proposalId ?? "?"}${amt}`;
  });

  return (
    `📋 <b>Proposal${items.length > 1 ? "s" : ""} approved</b> (${items.length})\n\n` +
    `${lines.join("\n")}\n\n` +
    `Start the build when ready: <code>/q engineering create issue for {company} build</code>`
  );
}

/** Format consumed demo_ready signals for sales follow-up. */
export function formatDemoNudge(signals: DeptSignal[]): string {
  const items = signals.filter((s) => s.event_type === "demo_ready");
  if (items.length === 0) return "";

  const lines = items.map((s) => {
    const p = (s.payload ?? {}) as { company?: string; repoUrl?: string };
    return `• <b>${p.company ?? "Unknown"}</b> — demo at ${p.repoUrl ?? "?"}`;
  });

  return (
    `🚀 <b>Demo${items.length > 1 ? "s" : ""} ready</b> (${items.length})\n\n` +
    `${lines.join("\n")}\n\n` +
    `Follow up when ready: <code>/q sales email {company} about the demo</code> — you approve before anything sends.`
  );
}

/** Format consumed design_brief_ready signals for engineering build. */
export function formatDesignBriefNudge(signals: DeptSignal[]): string {
  const items = signals.filter((s) => s.event_type === "design_brief_ready");
  if (items.length === 0) return "";

  const lines = items.map((s) => {
    const p = (s.payload ?? {}) as { client?: string; preset?: string };
    return `• <b>${p.client ?? "Unknown"}</b> — preset ${p.preset ?? "?"}`;
  });

  return (
    `🎨 <b>Design brief${items.length > 1 ? "s" : ""} ready</b> (${items.length})\n\n` +
    `${lines.join("\n")}\n\n` +
    `Build when ready: <code>/q engineering build cinematic landing for {client} using {preset} preset</code>`
  );
}

/** Format consumed site_deployed signals for sales follow-up. */
export function formatSiteDeployedNudge(signals: DeptSignal[]): string {
  const items = signals.filter((s) => s.event_type === "site_deployed");
  if (items.length === 0) return "";

  const lines = items.map((s) => {
    const p = (s.payload ?? {}) as { client?: string; siteUrl?: string; presetUsed?: string };
    const preset = p.presetUsed ? ` · ${p.presetUsed}` : "";
    return `• <b>${p.client ?? "Unknown"}</b> — ${p.siteUrl ?? "?"}${preset}`;
  });

  return (
    `🌐 <b>Site${items.length > 1 ? "s" : ""} deployed</b> (${items.length})\n\n` +
    `${lines.join("\n")}\n\n` +
    `Follow up when ready: <code>/q sales Proof Drop email to {client} with site link</code> — you approve before anything sends.`
  );
}

/** Format consumed proof_drop_ready signals for sales follow-up. */
export function formatProofDropNudge(signals: DeptSignal[]): string {
  const items = signals.filter((s) => s.event_type === "proof_drop_ready");
  if (items.length === 0) return "";

  const lines = items.map((s) => {
    const p = (s.payload ?? {}) as {
      company?: string;
      artifactType?: string;
      artifactSummary?: string;
    };
    const type = p.artifactType ? ` · ${p.artifactType}` : "";
    const summary = p.artifactSummary ? `\n  <i>${p.artifactSummary.slice(0, 120)}${p.artifactSummary.length > 120 ? "…" : ""}</i>` : "";
    return `• <b>${p.company ?? "Unknown"}</b>${type}${summary}`;
  });

  return (
    `🎁 <b>Proof Drop${items.length > 1 ? "s" : ""} ready</b> (${items.length})\n\n` +
    `${lines.join("\n")}\n\n` +
    `Send when ready: <code>/proofdrop {company}</code> or <code>/q sales draft Proof Drop email to {company}</code> — you approve before anything sends.`
  );
}

/**
 * Consume pending lead_discovered signals for the revenue dept and push a nudge.
 * consumePendingEvents claims rows with FOR UPDATE SKIP LOCKED, so each lead
 * surfaces exactly once even under concurrent sweeps (G2).
 */
export async function sweepDeptSignals(): Promise<void> {
  const sweeps: Array<{ event: string; toDept: string; format: (s: DeptSignal[]) => string }> = [
    { event: "lead_discovered", toDept: DEFAULT_TARGET_DEPT["lead_discovered"] ?? "sales", format: formatLeadNudge },
    {
      event: "proposal_approved",
      toDept: DEFAULT_TARGET_DEPT["proposal_approved"] ?? "engineering",
      format: formatProposalNudge,
    },
    { event: "demo_ready", toDept: DEFAULT_TARGET_DEPT["demo_ready"] ?? "sales", format: formatDemoNudge },
    {
      event: "design_brief_ready",
      toDept: DEFAULT_TARGET_DEPT["design_brief_ready"] ?? "engineering",
      format: formatDesignBriefNudge,
    },
    {
      event: "site_deployed",
      toDept: DEFAULT_TARGET_DEPT["site_deployed"] ?? "sales",
      format: formatSiteDeployedNudge,
    },
    {
      event: "proof_drop_ready",
      toDept: DEFAULT_TARGET_DEPT["proof_drop_ready"] ?? "sales",
      format: formatProofDropNudge,
    },
  ];

  for (const { event, toDept, format } of sweeps) {
    const signals = await consumePendingEvents(TENANT, toDept);
    const filtered = signals.filter((s) => s.event_type === event);
    const nudge = format(filtered);
    if (!nudge) continue;
    await sendToChat(nudge, "HTML");
    log.info({ count: filtered.length, event, toDept }, "Dept signal sweep — nudge sent");
  }
}

// ── Social cadence (Mon/Wed/Fri LinkedIn posting rhythm) ─────────────────────

const CADENCE_PILLARS: Record<number, string> = {
  1: "BUILD_LOG",       // Monday
  3: "AI_EDUCATION",   // Wednesday
  5: "FOUNDER_STORY",  // Friday
};

/**
 * Build the scheduler prompt for a social cadence post.
 * Pure function — extracted for testability (rule #16, no prompt instructions in cron logic).
 */
export function buildSocialCadencePrompt(
  date: Date,
): { prompt: string; pillar: string; threadId: string } {
  const day = date.getDay();
  const pillar = CADENCE_PILLARS[day] ?? "BUILD_LOG";
  const dateStr = date.toISOString().split("T")[0]!;
  const threadId = `${TENANT}:marketing:cadence:${dateStr}`;
  const prompt =
    `Social cadence post for today (${dateStr}). Content pillar: ${pillar}.\n` +
    `Research what's trending in AI/engineering/LLM this week, then write and post a LinkedIn post using the ${pillar} pillar.\n` +
    `Focus on FounderOS capabilities or Turicks mission. The post must appeal to hiring managers at AI companies — show technical depth and real-world impact. Call linkedin_post when done (HITL card will fire for approval).`;
  return { prompt, pillar, threadId };
}

/**
 * Mon/Wed/Fri cadence job — triggers the marketing dept to research + draft + HITL a post.
 * Budget-gated. Times out after 5 min (same as Monday brief) to keep cron loop unblocked.
 */
async function sendSocialCadenceNudge(): Promise<void> {
  const spent = await getTodayCostUsd(TENANT);
  const dailyGate = checkDailyBudgetGate(spent, getDailyBudgetCapUsd());
  if (!dailyGate.ok) {
    log.warn({ spent }, "Social cadence skipped — daily budget cap reached");
    return;
  }

  const { prompt, pillar, threadId } = buildSocialCadencePrompt(new Date());
  log.info({ pillar, threadId }, "Social cadence firing…");

  const office = getSchedulerOffice();
  const config = { configurable: { thread_id: threadId } };

  const CADENCE_TIMEOUT_MS = 5 * 60 * 1000;
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Social cadence LLM timed out (>5 min)")), CADENCE_TIMEOUT_MS),
  );

  try {
    await Promise.race([
      office.invoke({ messages: [new HumanMessage(prompt)] }, config),
      timeoutPromise,
    ]);
    log.info({ pillar }, "Social cadence fired — HITL card surfaced to Telegram");
  } catch (err) {
    log.error({ err: (err as Error).message }, "Social cadence failed");
    await sendToChat(
      `⚠️ Social cadence failed (${pillar}): ${(err as Error).message}`,
      "HTML",
    );
  }
}

/** Wednesday nudge when Proof Drop cadence is below target (no LLM). */
async function sendProofDropCadenceNudge(): Promise<void> {
  const stats = await getProofDropStats(TENANT);
  const nudge = buildProofDropCadenceNudge(stats);
  if (!nudge) {
    log.info({ count: stats.countThisWeek, target: stats.target }, "Proof Drop cadence on track — no nudge");
    return;
  }
  await sendToChat(nudge, "HTML");
  log.info({ count: stats.countThisWeek, target: stats.target }, "Proof Drop cadence nudge sent");
}

// ── Auto brain sync ───────────────────────────────────────────────────────────

/**
 * Run the turicks-brain sync script in a child process.
 *
 * Why automated: brain:sync was a manual step. If it doesn't run, the RAG
 * store goes empty — which looks like "Ollama unavailable" at query time
 * (the 2026-06-15 production outage). Rule #22: data-provisioning is part
 * of "done"; automation closes the gap.
 *
 * Runs at 2am daily (off-peak). Failure is non-fatal and reported to Telegram.
 */
export async function runBrainSync(): Promise<void> {
  log.info("Auto brain sync starting…");
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx/esm", "scripts/sync-turicks-brain.ts"],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], timeout: 5 * 60_000 },
    );
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("close", (code) => {
      if (code === 0) {
        log.info("Auto brain sync completed");
      } else {
        log.error({ code, stderr: stderr.slice(0, 500) }, "Auto brain sync failed");
        sendToChat(`⚠️ Auto brain sync failed (exit ${code ?? "?"}).\\nRun <code>pnpm brain:sync</code> manually.`, "HTML").catch(() => {});
      }
      resolve();
    });
    child.on("error", (err) => {
      log.error({ err: err.message }, "Auto brain sync spawn error");
      sendToChat(`⚠️ Auto brain sync spawn error: ${err.message}`, "HTML").catch(() => {});
      resolve();
    });
  });
}

/** Hourly check — alert at 80% and 100% daily budget (zero LLM, deduped per day). */
async function sendDailyBudgetAlertIfNeeded(): Promise<void> {
  const spent = await getTodayCostUsd(TENANT);
  const cap = getDailyBudgetCapUsd();
  const status = assessDailyBudget(spent, cap);
  const alertsState = await getBudgetAlertsState(TENANT);
  const threshold = nextBudgetAlertThreshold(status, alertsState.levels);
  if (!threshold) return;

  const msg = formatBudgetThresholdAlert(status, threshold);
  await sendToChat(msg, "HTML");
  await recordBudgetAlertSent(TENANT, threshold);
  log.info({ spent, cap, threshold }, "Daily budget threshold alert sent");
}

// ── Scheduler boot ────────────────────────────────────────────────────────────

export function startScheduler(): void {
  // Monday 8:00am (local server time — deploy in your timezone)
  cron.schedule("0 8 * * 1", () => {
    sendMondayBrief().catch((err) => {
      log.error({ err: (err as Error).message }, "Monday brief failed");
      sendToChat(`⚠️ Monday brief failed: ${(err as Error).message}`, "HTML").catch(() => {});
    });
  });

  // Daily 9:00am — stale approval check
  cron.schedule("0 9 * * *", () => {
    sendStaleApprovalReminder().catch((err) => {
      log.error({ err: (err as Error).message }, "Stale approval check failed");
      sendToChat(`⚠️ Stale approval check failed: ${(err as Error).message}`, "HTML").catch(() => {});
    });
  });

  // Monday 8:05am — outbound nudge (just after the brief)
  cron.schedule("5 8 * * 1", () => {
    sendOutboundNudge().catch((err) => {
      log.error({ err: (err as Error).message }, "Outbound nudge failed");
      sendToChat(`⚠️ Outbound nudge failed: ${(err as Error).message}`, "HTML").catch(() => {});
    });
  });

  // Wednesday 9:05am — Proof Drop cadence reminder (Phase D-Bis)
  cron.schedule("5 9 * * 3", () => {
    sendProofDropCadenceNudge().catch((err) => {
      log.error({ err: (err as Error).message }, "Proof Drop cadence nudge failed");
      sendToChat(`⚠️ Proof Drop nudge failed: ${(err as Error).message}`, "HTML").catch(() => {});
    });
  });

  // Hourly — consume durable dept_signals (lead_discovered → revenue nudge).
  // Rows are marked consumed atomically, so each lead surfaces exactly once.
  cron.schedule("0 * * * *", () => {
    sweepDeptSignals().catch((err) => {
      log.error({ err: (err as Error).message }, "Dept signal sweep failed");
      sendToChat(`⚠️ Dept signal sweep failed: ${(err as Error).message}`, "HTML").catch(() => {});
    });
    sendDailyBudgetAlertIfNeeded().catch((err) => {
      log.error({ err: (err as Error).message }, "Daily budget alert check failed");
    });
  });

  // Daily 2am — auto brain:sync (prevents the empty-RAG production outage class).
  // Off-peak; non-fatal on failure (Telegram alert sent, bot continues).
  cron.schedule("0 2 * * *", () => {
    runBrainSync().catch((err) => {
      log.error({ err: (err as Error).message }, "Auto brain sync cron error");
    });
  });

  // Mon/Wed/Fri 9:10am — social cadence: research trend → marketing drafts → HITL card.
  // 9:10am (10 min after stale-approval check) to avoid cron pile-up.
  cron.schedule("10 9 * * 1,3,5", () => {
    sendSocialCadenceNudge().catch((err) => {
      log.error({ err: (err as Error).message }, "Social cadence cron error");
      sendToChat(`⚠️ Social cadence failed: ${(err as Error).message}`, "HTML").catch(() => {});
    });
  });

  log.info("Scheduler started — Monday brief (Mon 8am) + outbound nudge (Mon 8:05am), Proof Drop cadence (Wed 9:05am), stale approval check (daily 9am), social cadence (Mon/Wed/Fri 9:10am), dept-signal sweep + budget alerts (hourly), auto brain sync (daily 2am)");
}
