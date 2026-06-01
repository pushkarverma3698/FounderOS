/**
 * FounderOS — Background Scheduler
 * ==================================
 * Five cron jobs registered at startup. These are NOT graph nodes — they are
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
 *  5. turicks-brain sync        — every Sunday 3am UTC (ADRs, brand, phase docs → knowledge_entries)
 *
 * See ADR-002 (scheduler-not-graph pattern) in docs/decisions/
 */

import cron from "node-cron";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { getDb } from "../db/client.js";
import { hitlApprovals, actionLog, knowledgeEntries } from "../db/schema.js";
import { resolveInterrupt, consumePendingEvents, publishDeptEvent } from "../db/queries.js";
import { childLogger } from "./logger.js";
import { env } from "../core/config.js";
import { and, eq, lt } from "drizzle-orm";
import { nextContentTopic } from "../core/prompts.js";

/**
 * Send a plain-text Telegram message via Bot API (no grammy dependency — avoids circular import).
 * Used by scheduler for maintenance alerts.
 */
async function sendTelegramAlert(text: string, topicId?: number): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    };
    if (topicId) body["message_thread_id"] = topicId;

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    log.warn({ err: (err as Error).message }, "sendTelegramAlert failed");
  }
}

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

    // Publish a dept event → dept_events_poller routes to marketing pod graph
    await publishDeptEvent({
      tenant_id: tenant,
      from_dept: "social",
      to_dept: "marketing",
      event_type: "linkedin_post_requested",
      thread_id: idempKey,
      payload: { topic, week, topic_index: topicIdx },
      consumed: false,
    });

    log.info({ topic }, "LinkedIn poster: dept event published → marketing pod will handle");

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

  const tenant = "turicks";
  // Idempotency: rate-limit to one run per 10-minute window
  // Prevents double-execution on process restart (P4-HARD-5)
  const windowMin = Math.floor(Date.now() / (10 * 60 * 1000));
  const idempKey = `reply_poller:${tenant}:${windowMin}`;

  try {
    const db = getDb();

    const existing = await db
      .select({ id: actionLog.id })
      .from(actionLog)
      .where(eq(actionLog.idempotency_key, idempKey))
      .limit(1);

    if (existing.length > 0) {
      log.debug({ idempKey }, "Reply poller already ran this window — skipping");
      return;
    }

    await db.insert(actionLog).values({
      tenant_id: tenant,
      action: "reply_poller_run",
      idempotency_key: idempKey,
      payload: { window_min: windowMin },
    });

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
      log.info({ interrupt_id: row.interrupt_id, thread_id: row.thread_id }, "HITL expired");
    }

    // Telegram boardroom alert
    const boardroomTopic = parseInt(process.env["TOPIC_BOARDROOM"] ?? "0") || undefined;
    await sendTelegramAlert(
      `⏰ <b>HITL Sweeper</b>: ${stale.length} interrupt(s) expired and marked abandoned.\n\nCheck pending leads in the pipeline.`,
      boardroomTopic,
    );

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

  // Idempotency: rate-limit to one sweep per 2-minute window (P4-HARD-5)
  // Prevents double-execution if process restarts during a sweep.
  const windowMin = Math.floor(Date.now() / (2 * 60 * 1000));
  const idempKey = `dept_events_sweep:${tenant}:${windowMin}`;

  try {
    const db = getDb();

    const existing = await db
      .select({ id: actionLog.id })
      .from(actionLog)
      .where(eq(actionLog.idempotency_key, idempKey))
      .limit(1);

    if (existing.length > 0) {
      log.debug({ idempKey }, "Dept events poller already ran this window — skipping");
      return;
    }

    await db.insert(actionLog).values({
      tenant_id: tenant,
      action: "dept_events_sweep",
      idempotency_key: idempKey,
      payload: { window_min: windowMin },
    });

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

        // Route to target pod via dynamic import (avoids circular infra → agents dep)
        if (ev.event_type === "linkedin_post_requested" && dept === "marketing") {
          const topic = (ev.payload as { topic?: string }).topic ?? "AI agent OS";
          // Dynamic import avoids circular dep (infra → agents is not allowed statically)
          const { getGraph } = await import("../agents/graph.js");
          const graph = await getGraph();
          if (graph) {
            void graph.invoke(
              {
                task: `Draft and publish a LinkedIn post about: ${topic}`,
                tenant_id: tenant,
                trace_id: ev.thread_id ?? ev.id,
              },
              { configurable: { thread_id: `${tenant}:social:${ev.id}` } },
            ).catch((err: Error) => log.error({ err: err.message, event_id: ev.id }, "Graph invoke failed for linkedin_post_requested"));
          }
        }
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

// ── turicks-brain weekly sync ─────────────────────────────────────────────────

interface BrainDoc {
  entry_type: string;
  title: string;
  content: string;
  source: string;
  tags: string[];
  metadata?: Record<string, unknown>;
}

function readSafe(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

function titleFromFile(file: string): string {
  return basename(file, ".md").replace(/[-_]/g, " ");
}

function collectBrainDocs(): BrainDoc[] {
  const root = process.cwd();
  const docs: BrainDoc[] = [];

  // ADRs
  const decisionsDir = join(root, "docs/decisions");
  if (existsSync(decisionsDir)) {
    for (const f of readdirSync(decisionsDir).filter((f) => f.endsWith(".md"))) {
      const num = parseInt(f.match(/^(\d+)/)?.[1] ?? "0");
      docs.push({ entry_type: "adr", title: titleFromFile(f), content: readSafe(join(decisionsDir, f)), source: `docs/decisions/${f}`, tags: ["architecture", "decision", `adr-${num}`], metadata: { adr_number: num } });
    }
  }

  // Strategic vision
  const sv = join(root, "docs/architecture/STRATEGIC-VISION.md");
  if (existsSync(sv)) docs.push({ entry_type: "strategic_pillar", title: "FounderOS Strategic Vision — 6 Pillars", content: readSafe(sv), source: "docs/architecture/STRATEGIC-VISION.md", tags: ["strategy", "architecture", "pillars"] });

  // Brand
  const brand = join(root, "docs/BRAND.md");
  if (existsSync(brand)) docs.push({ entry_type: "brand", title: "Turicks Brand Guidelines (project summary)", content: readSafe(brand), source: "docs/BRAND.md", tags: ["brand", "voice", "guidelines"] });

  // Phase docs
  const phasesDir = join(root, "docs/phases");
  if (existsSync(phasesDir)) {
    for (const f of readdirSync(phasesDir).filter((f) => f.endsWith(".md"))) {
      const num = parseInt(f.match(/PHASE-(\d+)/i)?.[1] ?? "0");
      docs.push({ entry_type: "phase", title: titleFromFile(f), content: readSafe(join(phasesDir, f)), source: `docs/phases/${f}`, tags: ["phase", `phase-${num}`], metadata: { phase_number: num } });
    }
  }

  // Study docs (case study, strategy, research) — all .md
  const studyDir = join(root, "docs/study");
  if (existsSync(studyDir)) {
    for (const f of readdirSync(studyDir).filter((f) => f.endsWith(".md"))) {
      const isCaseStudy = /CASE-STUDY/i.test(f);
      docs.push({
        entry_type: isCaseStudy ? "case_study" : "strategy",
        title: isCaseStudy ? "Turicks / FounderOS Case Study Log" : titleFromFile(f),
        content: readSafe(join(studyDir, f)),
        source: `docs/study/${f}`,
        tags: isCaseStudy ? ["case-study", "milestones"] : ["strategy", "study", "research"],
      });
    }
  }

  return docs;
}

async function runBrainSync(): Promise<void> {
  const db = getDb();
  const docs = collectBrainDocs();
  let inserted = 0, updated = 0, skipped = 0;

  for (const doc of docs) {
    try {
      const existing = await db
        .select()
        .from(knowledgeEntries)
        .where(and(eq(knowledgeEntries.tenant_id, "turicks"), eq(knowledgeEntries.title, doc.title), eq(knowledgeEntries.is_current, true)))
        .limit(1);

      if (existing.length === 0) {
        await db.insert(knowledgeEntries).values({ tenant_id: "turicks", ...doc, version: 1, is_current: true });
        inserted++;
      } else if (existing[0]!.content !== doc.content) {
        await db.update(knowledgeEntries).set({ is_current: false }).where(eq(knowledgeEntries.id, existing[0]!.id));
        await db.insert(knowledgeEntries).values({ tenant_id: "turicks", ...doc, version: (existing[0]!.version ?? 1) + 1, is_current: true });
        updated++;
      } else {
        skipped++;
      }
    } catch (err) {
      log.warn({ title: doc.title, err: (err as Error).message }, "brain:sync entry failed");
    }
  }

  log.info({ inserted, updated, skipped, total: docs.length }, "turicks-brain sync complete");
  await sendTelegramAlert(`🧠 <b>turicks-brain synced</b>\n${inserted} new · ${updated} updated · ${skipped} unchanged`);
}

// ─────────────────────────────────────────────────────────────────────────────

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

  // Job 5: turicks-brain sync — every Sunday 3am UTC
  cron.schedule("0 3 * * 0", () => {
    void runBrainSync();
  });
  log.info("Scheduler: turicks-brain sync registered (Sun 03:00 UTC)");

  log.info("FounderOS scheduler initialized — 5 jobs active");
}

/** Stop all scheduled tasks. Call in SIGTERM handler. */
export function stopScheduler(): void {
  cron.getTasks().forEach((task) => task.stop());
  _initialized = false;
  log.info("Scheduler stopped");
}
