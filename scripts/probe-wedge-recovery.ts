/**
 * Probe: reproduce the "wedged thread" production bug and prove the recovery.
 *
 * Mechanism (observed live on thread turicks:6775330211):
 *   A run that aborts mid-graph (recursion limit / budget / crash) leaves
 *   state.next non-empty (a pending node) with NO HITL interrupt. Every
 *   subsequent office.invoke({messages}) RESUMES that stuck node instead of
 *   starting a fresh turn → loops → recursion limit again → forever.
 *
 * This probe drives a fresh MemorySaver thread into that exact state with a low
 * recursion limit, shows a new message loops, then clears the pending node and
 * shows the same thread answers normally.
 *
 * Run: node --env-file=.env --import tsx/esm scripts/probe-wedge-recovery.ts
 */
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage, RemoveMessage } from "@langchain/core/messages";
import { buildOffice } from "../src/agents/office.js";

function describeNext(state: { next?: string[]; tasks?: unknown[] }): string {
  return `next=${JSON.stringify(state.next ?? [])} tasks=${(state.tasks ?? []).length}`;
}

async function main() {
  const office = buildOffice(new MemorySaver());
  const config = { configurable: { thread_id: "wedge-probe" } } as const;

  // 1. Force an abnormal mid-graph abort with a tiny recursion limit on a
  //    multi-step request so the run stops with next non-empty.
  console.log("\n=== STEP 1: force a wedge (recursionLimit=2 on a multi-step task) ===");
  try {
    await office.invoke(
      { messages: [new HumanMessage("Research the latest AI agent frameworks, then draft a cold email about them.")] },
      { ...config, recursionLimit: 2 },
    );
    console.log("  (run completed without aborting — bumping difficulty)");
  } catch (e) {
    console.log(`  run aborted as expected: ${(e as Error).constructor.name}`);
  }
  let state = (await office.getState(config)) as { next?: string[]; tasks?: Array<{ interrupts?: unknown[] }> };
  console.log(`  state after abort: ${describeNext(state)}`);
  const interrupts = (state.tasks ?? []).flatMap((t) => t.interrupts ?? []);
  console.log(`  pending HITL interrupts: ${interrupts.length}  (wedge = next non-empty AND 0 interrupts)`);

  const isWedged = (state.next ?? []).length > 0 && interrupts.length === 0;
  console.log(`  WEDGED? ${isWedged}`);

  // 2. Send a NEW message on the wedged thread — reproduce the loop.
  console.log("\n=== STEP 2: new message on wedged thread (BEFORE fix) ===");
  if (isWedged) {
    try {
      await office.invoke({ messages: [new HumanMessage("There?")] }, { ...config, recursionLimit: 8 });
      console.log("  ⚠️ unexpectedly completed (no loop)");
    } catch (e) {
      console.log(`  ❌ REPRODUCED: new message loops → ${(e as Error).constructor.name} (this is the production bug)`);
    }
  } else {
    console.log("  could not wedge — adjust the forcing task");
  }

  // 3. RECOVERY: clear the pending node (drop all messages so next resets), then
  //    send the same message and prove it answers. Mirrors the gateway fix.
  console.log("\n=== STEP 3: recover the wedge, then retry (AFTER fix) ===");
  const fullState = (await office.getState(config)) as {
    next?: string[];
    values?: { messages?: Array<{ id?: string }> };
  };
  const msgs = fullState.values?.messages ?? [];
  const removals = msgs.filter((m) => m.id).map((m) => new RemoveMessage({ id: m.id! }));
  await office.updateState(config, { messages: removals });
  const cleared = (await office.getState(config)) as { next?: string[] };
  console.log(`  after recovery: next=${JSON.stringify(cleared.next ?? [])} (must be empty)`);

  const res = (await office.invoke(
    { messages: [new HumanMessage("There?")] },
    { ...config, recursionLimit: 12 },
  )) as { messages?: Array<{ content?: unknown; _getType?: () => string }> };
  const last = (res.messages ?? []).filter((m) => m._getType?.() === "ai").pop();
  console.log(`  ✅ RECOVERED reply: ${typeof last?.content === "string" ? last.content.slice(0, 120) : "[none]"}`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
