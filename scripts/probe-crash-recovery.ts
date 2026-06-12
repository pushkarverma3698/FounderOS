/**
 * FounderOS — Crash-Recovery Probe (real, cross-process)
 * =======================================================
 * Proves the headline safety claim: a pending HITL approval survives a process
 * crash because the interrupt is persisted in the Postgres checkpointer.
 *
 * This is deliberately split into two phases run as SEPARATE `node` processes so
 * they share NOTHING but Postgres (no in-memory office, no shared checkpointer
 * instance) — a faithful crash simulation:
 *
 *   phase1: invoke a HITL-gated task on a fixed thread → reach interrupt() →
 *           assert a pending approval exists + a checkpoint row exists → EXIT
 *           WITHOUT RESUMING (this is the "crash").
 *   phase2: a brand-new process loads the SAME thread → asserts the pending
 *           approval is STILL there (survived the crash) → resumes with REJECT
 *           (fail-safe: no side effect) → asserts the run completed.
 *
 * Usage (the thread id ties the two processes together):
 *   THREAD=crash-probe:$(date +%s) ; \
 *   PROBE_THREAD=$THREAD node --env-file=.env --import tsx/esm scripts/probe-crash-recovery.ts phase1 ; \
 *   PROBE_THREAD=$THREAD node --env-file=.env --import tsx/esm scripts/probe-crash-recovery.ts phase2
 */

import { Command } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getOffice, getPendingApproval } from "../src/agents/office.js";
import { closeDatabaseConnections, getDb } from "../src/db/client.js";
import { sql } from "drizzle-orm";

const phase = process.argv[2];
const threadId = process.env["PROBE_THREAD"];

if (!threadId) {
  console.error("FAIL: set PROBE_THREAD env to a unique thread id");
  process.exit(2);
}
const config: RunnableConfig = { configurable: { thread_id: threadId } };

// A reliably HITL-gated task: personal → run_shell ALWAYS interrupts before running.
// Direct-route prefix removes routing flakiness so the probe tests recovery, not routing.
const HITL_TASK =
  "[Route directly to personal department]: Run the shell command `echo crash-recovery-probe` in ~/Projects/founderos";

async function countCheckpoints(): Promise<number> {
  const db = getDb();
  const r = await db.execute(
    sql`select count(*)::int as n from checkpoints where thread_id = ${threadId}`,
  );
  // postgres.js driver returns an array (RowList); pg driver returns { rows }.
  const rows = (Array.isArray(r) ? r : (r as { rows?: Array<{ n: number }> }).rows) ?? [];
  return Number((rows[0] as { n?: number } | undefined)?.n ?? 0);
}

async function phase1(): Promise<void> {
  console.log(`\n[phase1] thread=${threadId} — invoking HITL task, then 'crashing' (exit without resume)`);
  const office = await getOffice();
  await office.invoke({ messages: [new HumanMessage(HITL_TASK)] }, config);

  const pending = await getPendingApproval(office, config);
  const ckpts = await countCheckpoints();
  console.log(`[phase1] pendingApproval = ${pending ? "PRESENT ✅" : "ABSENT ❌"}  (${pending?.title ?? "—"})`);
  console.log(`[phase1] checkpoint rows for thread = ${ckpts}`);

  if (!pending) {
    console.error("[phase1] FAIL: no interrupt fired — cannot test recovery");
    process.exitCode = 1;
    return;
  }
  if (ckpts === 0) {
    console.error("[phase1] FAIL: interrupt fired but no checkpoint persisted — would NOT survive a crash");
    process.exitCode = 1;
    return;
  }
  console.log("[phase1] OK — interrupt persisted to Postgres. Exiting WITHOUT resume (simulated crash).");
}

async function phase2(): Promise<void> {
  console.log(`\n[phase2] thread=${threadId} — COLD process, reloading from Postgres only`);
  const office = await getOffice(); // fresh office + fresh checkpointer connection

  const survived = await getPendingApproval(office, config);
  console.log(`[phase2] pendingApproval after 'restart' = ${survived ? "SURVIVED ✅" : "LOST ❌"}  (${survived?.title ?? "—"})`);
  if (!survived) {
    console.error("[phase2] FAIL: pending approval did NOT survive the crash");
    process.exitCode = 1;
    return;
  }

  // Resume with REJECT — fail-safe, so the shell command never runs (no side effect).
  console.log("[phase2] resuming with REJECT (fail-safe — command must NOT execute)…");
  const res = (await office.invoke(new Command({ resume: "rejected" }), config)) as {
    messages?: Array<{ content?: unknown }>;
  };
  const stillPending = await getPendingApproval(office, config);
  console.log(`[phase2] pendingApproval after resume = ${stillPending ? "STILL PENDING ❌" : "CLEARED ✅"}`);
  const lastMsg = res.messages?.[res.messages.length - 1]?.content;
  console.log(`[phase2] final message: ${typeof lastMsg === "string" ? lastMsg.slice(0, 200) : JSON.stringify(lastMsg)?.slice(0, 200)}`);

  if (stillPending) {
    console.error("[phase2] FAIL: approval not cleared after resume");
    process.exitCode = 1;
    return;
  }
  console.log("[phase2] OK — approval survived the crash AND was resumable. CRASH-RECOVERY VERIFIED ✅");
}

(async () => {
  try {
    if (phase === "phase1") await phase1();
    else if (phase === "phase2") await phase2();
    else {
      console.error("usage: probe-crash-recovery.ts <phase1|phase2>  (with PROBE_THREAD set)");
      process.exitCode = 2;
    }
  } catch (err) {
    console.error("PROBE ERROR:", err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  } finally {
    await closeDatabaseConnections().catch(() => {});
    setTimeout(() => process.exit(process.exitCode ?? 0), 200);
  }
})();
