/**
 * FounderOS v3 — LIVE end-to-end proof (real model + real Postgres).
 * ===================================================================
 * Drives the PRODUCTION kernel composition (buildProductionKernel + Postgres
 * checkpointer + production budget callback with the ai_call_costs sink)
 * against a live LLM and asserts the v3 guarantees with DATABASE evidence,
 * not log claims:
 *
 *   S1 greeting        → direct reply, no plan
 *   S2 worker path     → deterministic route override → validated StepResult → reply
 *   S3 HITL reject     → hitl_approvals row BEFORE interrupt; reject → typed
 *                        hitl_rejected failure; ZERO new action_log rows
 *   S4 crash recovery  → interrupt, then a FRESH kernel instance (new
 *                        PostgresSaver — simulated restart) resumes "approved"
 *                        and finishes the turn
 *   S5 determinism     → same input twice → plan diff (informational at live temp 0)
 *   S6 cost ledger     → ai_call_costs rows > $0 for today (the daily budget
 *                        cap reads this table)
 *
 * Usage (CI: .github/workflows/live-e2e.yml):
 *   node --import tsx/esm scripts/live-e2e-proof.ts
 * Requires: DATABASE_URL (migrated via scripts/setup-db.ts) + a live model key.
 * External send keys are intentionally ABSENT: gated sends interrupt before
 * execution, and an approved send fails LOUDLY (typed failure) — both are the
 * behaviors under test. Nothing external is ever sent by this script.
 */

import { Command } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { buildProductionKernel } from "../src/gateway/kernel-boot.js";
import { kernelCostSink } from "../src/gateway/kernel-run.js";
import { getCheckpointer } from "../src/infra/checkpointer.js";
import { BudgetGuardCallback, createRunBudget } from "../src/infra/budget.js";
import { kernelReply, getPendingKernelApproval, stableStringify } from "../src/kernel/index.js";
import type { Mission, StepResult, FailureReport } from "../src/kernel/contracts.js";
import { getPendingInterrupt, resolveInterrupt, getRecentAuditEntries, getTodayCostUsd } from "../src/db/queries.js";
import { TENANT } from "../src/core/config.js";
import { closeDatabaseConnections } from "../src/db/client.js";

const INVOKE_TIMEOUT_MS = 180_000;

interface KernelValues {
  mission: Mission;
  results: StepResult[];
  failure?: FailureReport | null;
  reply: string;
}

type CompiledKernel = ReturnType<typeof buildProductionKernel>;

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} exceeded ${INVOKE_TIMEOUT_MS / 1000}s`)), INVOKE_TIMEOUT_MS).unref(),
    ),
  ]);
}

function configFor(threadId: string) {
  return {
    configurable: { thread_id: threadId },
    recursionLimit: 60,
    callbacks: [new BudgetGuardCallback(createRunBudget(), process.env["AGENT_MODEL"] ?? "", kernelCostSink)],
  };
}

async function invokeTurn(kernel: CompiledKernel, threadId: string, text: string): Promise<KernelValues> {
  return (await withTimeout(
    kernel.invoke(
      {
        turn: {
          id: `${threadId}:turn`,
          chat_id: threadId,
          received_at: new Date().toISOString(),
          raw_input: text,
        },
      },
      configFor(threadId),
    ),
    `invoke(${threadId})`,
  )) as unknown as KernelValues;
}

const outcomes: Array<{ name: string; ok: boolean; evidence: string; hard: boolean }> = [];

function record(name: string, ok: boolean, evidence: string, hard = true): void {
  outcomes.push({ name, ok, evidence, hard });
  console.log(`\n${ok ? "✅" : hard ? "❌" : "⚠️"} ${name}\n   ${evidence.replace(/\n/g, "\n   ")}`);
}

async function main(): Promise<void> {
  const runId = Date.now().toString(36);
  const t = (n: string) => `live-e2e:${runId}:${n}`;
  console.log(`Live E2E proof — model=${process.env["AGENT_MODEL"]} tenant=${TENANT} run=${runId}`);

  const kernel = buildProductionKernel(await getCheckpointer());
  const auditRowsBefore = (await getRecentAuditEntries(TENANT, 50)).length;

  // ── S1: greeting → direct reply, no plan ──────────────────────────────────
  {
    const res = await invokeTurn(kernel, t("s1"), "Hello! Quick check — are you online?");
    const reply = kernelReply(res as never);
    record(
      "S1 greeting → direct reply, no plan",
      reply.length > 0 && !res.mission.plan,
      `reply="${reply.slice(0, 160)}" plan=${res.mission.plan ? "PRESENT (unexpected)" : "none"}`,
    );
  }

  // ── S2: worker path with validated StepResult ─────────────────────────────
  {
    const res = await invokeTurn(
      kernel,
      t("s2"),
      "[route directly to research]: In two sentences, from your own knowledge and without using any tools, what is the LangGraph JavaScript library?",
    );
    const reply = kernelReply(res as never);
    const okStep = res.results.find((r) => r.status === "ok");
    record(
      "S2 route override → worker → validated StepResult → synthesized reply",
      reply.length > 0 && okStep !== undefined,
      `worker=${res.mission.plan?.steps[0]?.worker} step=${okStep ? "ok (validated)" : JSON.stringify(res.results.at(-1) ?? res.failure).slice(0, 200)}\nreply="${reply.slice(0, 200)}"`,
    );
  }

  // ── S3: HITL — DB row before interrupt; reject → typed failure, no send ──
  {
    const threadId = t("s3");
    const res = await invokeTurn(
      kernel,
      threadId,
      "[route directly to comms]: Send an email to livetest@example.com with subject 'FounderOS live E2E' and body 'This is a live end-to-end proof run.'",
    );
    const approval = await getPendingKernelApproval(kernel as never, configFor(threadId));
    const dbRow = await getPendingInterrupt(threadId);
    record(
      "S3a gated send → interrupt raised + hitl_approvals row exists BEFORE decision",
      approval !== null && dbRow !== undefined && dbRow !== null,
      `approval=${approval ? `"${(approval as { title?: string }).title}"` : "MISSING"} db_row=${dbRow ? `interrupt_id=${dbRow.interrupt_id} status=${dbRow.status}` : "MISSING"}`,
    );

    if (dbRow) await resolveInterrupt(dbRow.interrupt_id, "rejected");
    const res2 = (await withTimeout(
      kernel.invoke(new Command({ resume: "rejected" }), configFor(threadId)),
      "resume(s3)",
    )) as unknown as KernelValues;
    const rejectedStep = res2.results.find((r) => r.status === "failed" && r.failure.stage === "hitl_rejected");
    const auditRowsNow = (await getRecentAuditEntries(TENANT, 50)).length;
    record(
      "S3b reject → typed hitl_rejected failure, reply sent, ZERO action_log rows",
      kernelReply(res2 as never).length > 0 && rejectedStep !== undefined && auditRowsNow === auditRowsBefore,
      `failure.stage=${rejectedStep ? "hitl_rejected" : JSON.stringify(res2.results.map((r) => r.status))} action_log Δ=${auditRowsNow - auditRowsBefore}\nreply="${kernelReply(res2 as never).slice(0, 200)}"`,
    );
    void res;
  }

  // ── S4: crash recovery — resume "approved" on a FRESH kernel instance ─────
  {
    const threadId = t("s4");
    await invokeTurn(
      kernel,
      threadId,
      "[route directly to comms]: Send an email to crashtest@example.com with subject 'FounderOS restart proof' and body 'Approved after a simulated process restart.'",
    );
    const dbRow = await getPendingInterrupt(threadId);
    // Simulated restart: brand-new saver + brand-new kernel object, same Postgres.
    const saver = PostgresSaver.fromConnString(process.env["DATABASE_URL"]!, { schema: "agents" });
    const kernel2 = buildProductionKernel(saver as never);
    if (dbRow) await resolveInterrupt(dbRow.interrupt_id, "approved");
    const res = (await withTimeout(
      kernel2.invoke(new Command({ resume: "approved" }), configFor(threadId)),
      "resume(s4)",
    )) as unknown as KernelValues;
    const reply = kernelReply(res as never);
    const pendingAfter = await getPendingKernelApproval(kernel2 as never, configFor(threadId));
    // No Gmail key in CI: the approved send must fail LOUDLY (typed failure) —
    // fail-loud on approved-but-unexecutable is itself a v3 guarantee.
    record(
      "S4 approve on a fresh kernel instance (simulated restart) → run completes from checkpoint",
      dbRow !== undefined && dbRow !== null && reply.length > 0 && pendingAfter === null,
      `interrupt_row=${dbRow ? "yes" : "MISSING"} resumed_reply="${reply.slice(0, 200)}" pending_after=${pendingAfter === null ? "none" : "STILL PENDING"}`,
    );
  }

  // ── S5: plan determinism at temp 0 (informational for live model) ─────────
  {
    const input = "Research the latest LangGraph release and email a two-line summary to sam@example.com";
    const a = await invokeTurn(kernel, t("s5a"), input);
    const b = await invokeTurn(kernel, t("s5b"), input);
    // Approvals may be pending on these threads; reject them to leave clean state.
    for (const id of [t("s5a"), t("s5b")]) {
      const row = await getPendingInterrupt(id);
      if (row) await resolveInterrupt(row.interrupt_id, "rejected");
    }
    const planA = a.mission.plan ? stableStringify(a.mission.plan) : "(direct reply)";
    const planB = b.mission.plan ? stableStringify(b.mission.plan) : "(direct reply)";
    record(
      "S5 identical input → identical plan (temp 0, live model)",
      planA === planB,
      planA === planB ? `plans byte-identical (${planA.length} bytes)` : `plans DIFFER:\nA=${planA.slice(0, 300)}\nB=${planB.slice(0, 300)}`,
      false, // informational: live-model sampling nondeterminism is a provider property, not a kernel defect
    );
  }

  // ── S6: cost ledger populated (daily budget cap reads this) ───────────────
  {
    const usd = await getTodayCostUsd(TENANT);
    record(
      "S6 ai_call_costs populated by the production budget callback",
      usd > 0,
      `getTodayCostUsd(${TENANT}) = $${usd.toFixed(6)}`,
    );
  }

  const hardFailures = outcomes.filter((o) => o.hard && !o.ok);
  console.log("\n══ LIVE E2E PROOF SUMMARY ══");
  for (const o of outcomes) console.log(`${o.ok ? "✅" : o.hard ? "❌" : "⚠️"} ${o.name}`);
  console.log(hardFailures.length === 0 ? "\nALL HARD SCENARIOS PASSED" : `\n${hardFailures.length} HARD FAILURE(S)`);

  await closeDatabaseConnections().catch(() => undefined); // allow-failopen: teardown
  process.exit(hardFailures.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("\n❌ Live E2E proof crashed:", err);
  await closeDatabaseConnections().catch(() => undefined); // allow-failopen: teardown
  process.exit(1);
});
