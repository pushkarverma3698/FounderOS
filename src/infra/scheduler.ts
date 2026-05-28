/**
 * FounderOS — Background Scheduler
 * ==================================
 * Four cron jobs registered at startup. These are NOT graph nodes — they are
 * time-triggered entry points that kick off agent runs or perform maintenance.
 *
 * Design decisions:
 * - node-cron (not LangGraph) for time-based triggers — graph nodes that sleep
 *   waiting for a clock tick are an antipattern (wastes checkpointer storage,
 *   blocks threads, hard to debug)
 * - Idempotency via audit_log — each job checks before acting, safe to re-run
 * - All jobs fail-open: errors are logged but never crash the process
 *
 * Jobs:
 *  1. LinkedIn content poster   — Mon/Wed/Fri 9am CET
 *  2. Gmail reply poller        — every 15 minutes
 *  3. HITL sweeper              — every hour (expires stale pending interrupts)
 *  4. Dept events poller        — every 5 minutes (Phase 3C cross-dept signals)
 *
 * See ADR-002 (scheduler-not-graph pattern) in docs/decisions/
 */

import cron from "node-cron";
import { getDb } from "../db/client.js";
import { hitlApprovals, actionLog } from "../db/schema.js";
import { resolveInterrupt, consumePendingEvents } from "../db/queries.js";
import { childLogger } from "./logger.js";
import { env } from "../core/config.js";
import { and, eq, lt } from "drizzle-orm";
import { nextContentTopic } from "../core/prompts.js";

const log = childLogger({ module: "scheduler" });

// ── State ─────────────────────────────────────────────────────────────────────

/** Round-robin cursor for content topic rotation. Persists for process lifetime. */
let _topicIndex = 0;

/** Returns ISO week number (1-53) for a given date. */
function isoWeek(d: Date = new Date()): number {
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const dayOfYear = Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 0).getTime()) / 86_400_000);
  return Math.ceil((dayOfYear + jan4.getDay()) / 7);
}

// ── Job 1: LinkedIn Content Poster ───────────────────────────────────────────

/**
 * Mon/Wed/Fri at 09:00 CET — post one LinkedIn content piece.
 * Uses round-robin topic from CONTENT_TOPICS.
 * Idempotency key: linkedin_post:{tenant}:{topic_index}:{week}
 *
 * Does NOT directly post — it fires the marketing pod via the graph.
 * The marketing pod handles HITL approval before the Composio LinkedIn call.
 */
async function runLinkedInPoster(): Promise<void> {
  const tenant = "turicks";
  const week = isoWeek();
  const topicIdx = _topicIndex;
  const topic = nextContentTopic(topicIdx);
  const idempKey = `linkedin_post:${tenant}:${topicIdx}:${week}`;

  try {
    const db = getDb();

    // Idempotency check
    const existing = await db
      .select({ id: actionLog.id })
      .from(actionLog)
      .where(eq(actionLog.idempotency_key, idempKey))
      .limit(1);

    if (existing.length > 0) {
      log.debug({ idempKey }, "LinkedIn post already scheduled this week — skipping");
      return;
    }

    log.info({ topic, week, topicIdx }, "LinkedIn poster: queuing content post");

    // Write audit entry to mark as scheduled (actual post happens via marketing pod → HITL)
    await db.insert(actionLog).values({
      tenant_id: tenant,
      action: "linkedin_post_queued",
      idempotency_key: idempKey,
      payload: { topic, week, topic_index: topicIdx },
    });

    // Advance topic cursor for next run
    _topicIndex = (_topicIndex + 1) % 12;

    // TODO Phase 2B: invoke marketing pod graph with { task: `LinkedIn post about: ${topic}` }
    // This stub logs intent — graph invocation wired when marketing pod is complete
    log.info({ topic }, "LinkedIn poster: audit entry written — graph invocation pending Phase 2B");

  } catch (err) {
    log.error({ err: (err as Error).message, idempKey }, "LinkedIn poster failed");
  }
}

// ── Job 2: Gmail Reply Poller ─────────────────────────────────────────────────

/**
 * Every 15 minutes — check for replies to sent outreach emails.
 * Matches Gmail thread IDs stored in lead_pipeline.email_thread_id.
 * Updates lead stage to 'replied' on match.
 *
 * Requires: COMPOSIO_API_KEY set, Gmail OAuth connected via Composio.
 */
async function runReplyPoller(): Promise<void> {
  if (!env.COMPOSIO_API_KEY) {
    log.debug("Reply poller: COMPOSIO_API_KEY not set — skipping");
    return;
  }

  try {
    // TODO Phase 2C: fetch unread Gmail threads matching sent thread IDs
    // const sentThreadIds = await db.select(...).from(leadPipeline).where(...)
    // for each thread: if reply found → updateLeadStage(leadId, 'replied')
    log.debug("Reply poller: stub run complete (Phase 2C implementation pending)");
  } catch (err) {
    log.warn({ err: (err as Error).message }, "Reply poller failed — will retry next cycle");
  }
}

// ── Job 3: HITL Sweeper ───────────────────────────────────────────────────────

/**
 * Every hour — expire stale pending interrupts.
 * Marks interrupt_registry rows as 'expired' where status='pending' and expires_at < now().
 * Updates lead_pipeline stage to 'abandoned_hitl' for the affected leads.
 * Sends a summary to Telegram Boardroom topic.
 *
 * This prevents interrupts from sitting in 'pending' forever if the founder
 * doesn't action them (e.g., on holiday, app notification missed).
 */
async function runHitlSweeper(): Promise<void> {
  try {
    const db = getDb();

    // Find expired pending interrupts
    const stale = await db
      .select({
        interrupt_id: hitlApprovals.interrupt_id,
        thread_id: hitlApprovals.thread_id,
        expires_at: hitlApprovals.expires_at,
      })
      .from(hitlApprovals)
      .where(
        and(
          eq(hitlApprovals.status, "pending"),
          lt(hitlApprovals.expires_at, new Date()),
        ),
      );

    if (stale.length === 0) {
      log.debug("HITL sweeper: no stale interrupts found");
      return;
    }

    log.info({ count: stale.length }, "HITL sweeper: expiring stale interrupts");

    for (const row of stale) {
      await resolveInterrupt(row.interrupt_id, "expired");
      // TODO Phase 2C: update lead_pipeline stage = 'abandoned_hitl' where thread_id matches
      log.info({ interrupt_id: row.interrupt_id, thread_id: row.thread_id }, "HITL expired");
    }

    // TODO Phase 1C: send Telegram summary to Boardroom topic
    // await sendTelegramMessage(env.TOPIC_BOARDROOM, `⏰ HITL sweeper: ${stale.length} interrupt(s) expired`)

  } catch (err) {
    log.error({ err: (err as Error).message }, "HITL sweeper failed");
  }
}

// ── Job 4: Dept Events Poller ─────────────────────────────────────────────────

/**
 * Every 5 minutes — drain unconsumed cross-department signals from dept_signals.
 *
 * Phase 3C cross-department signals flow:
 *   Pod writes publishDeptEvent() → dept_signals table (durable, consumed=false)
 *   This job polls and marks consumed=true → logs summary per department
 *
 * Future Phase 3C+: for each consumed event, resume or invoke the target
 * department's pod graph (e.g. sales "email_queued" → trigger marketing followup).
 *
 * Design: polls ALL known departments; each sweep is idempotent (consumed=true
 * prevents double-processing). Fails open — errors never crash the process.
 */
const DEPARTMENTS = ["sales", "engineering", "marketing", "social", "prospecting"] as const;

async function runDeptEventsPoller(): Promise<void> {
  const tenant = "turicks";

  try {
    let totalConsumed = 0;

    for (const dept of DEPARTMENTS) {
      const events = await consumePendingEvents(tenant, dept);

      if (events.length === 0) continue;

      totalConsumed += events.length;

      for (const ev of events) {
        log.info(
          {
            dept,
            event_type: ev.event_type,
            from_dept: ev.from_dept,
            thread_id: ev.thread_id,
            payload: ev.payload,
          },
          "Dept event consumed",
        );

        // TODO Phase 3C+: route consumed event to the target pod.
        // Example:
        //   if (dept === "marketing" && ev.event_type === "email_queued") {
        //     const graph = await getGraph();
        //     void graph.invoke(
        //       { task: `Follow up marketing for: ${(ev.payload as { company?: string }).company ?? "unknown"}`, tenant_id: tenant },
        //       { configurable: { thread_id: `${tenant}:mktg_followup:${ev.id}` } },
        //     );
        //   }
      }
    }

    if (totalConsumed > 0) {
      log.info({ total: totalConsumed, tenant }, "Dept events poller: consumed events");
    } else {
      log.debug("Dept events poller: no pending events");
    }

  } catch (err) {
    log.warn({ err: (err as Error).message }, "Dept events poller failed — will retry next cycle");
  }
}

// ── Scheduler Init ────────────────────────────────────────────────────────────

let _initialized = false;

/**
 * Register all cron jobs. Call once at startup (src/index.ts).
 * Safe to call multiple times — idempotent guard prevents double registration.
 */
export function initScheduler(): void {
  if (_initialized) {
    log.warn("initScheduler called twice — ignoring");
    return;
  }
  _initialized = true;

  // Job 1: LinkedIn poster — Mon/Wed/Fri 9am (UTC, CET = UTC+1/+2 — close enough for content)
  cron.schedule("0 9 * * 1,3,5", () => {
    void runLinkedInPoster();
  });
  log.info("Scheduler: LinkedIn poster registered (Mon/Wed/Fri 09:00)");

  // Job 2: Reply poller — every 15 minutes
  cron.schedule("*/15 * * * *", () => {
    void runReplyPoller();
  });
  log.info("Scheduler: Gmail reply poller registered (*/15 min)");

  // Job 3: HITL sweeper — every hour
  cron.schedule("0 * * * *", () => {
    void runHitlSweeper();
  });
  log.info("Scheduler: HITL sweeper registered (hourly)");

  // Job 4: Dept events poller — every 5 minutes (Phase 3C cross-dept signals)
  cron.schedule("*/5 * * * *", () => {
    void runDeptEventsPoller();
  });
  log.info("Scheduler: Dept events poller registered (*/5 min)");

  log.info("FounderOS scheduler initialized — 4 jobs active");
}

/** Stop all scheduled tasks. Call in SIGTERM handler. */
export function stopScheduler(): void {
  cron.getTasks().forEach((task) => task.stop());
  _initialized = false;
  log.info("Scheduler stopped");
}
