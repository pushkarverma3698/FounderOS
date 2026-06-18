#!/usr/bin/env node
/**
 * Production hardcore office probes — same class as local QA stabilization.
 * Runs through REAL getOffice() + Postgres checkpointer path (not MemorySaver).
 *
 * Usage (on VPS):
 *   node --env-file=.env --import tsx/esm scripts/vps-prod-hardcore-probes.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { detectGuardViolation } from "./lib/guard-check.js";
import {
  getStressOffice,
  runStressTask,
  runStressTaskRepeat,
  stressResultOk,
  type StressResult,
  type StressTask,
} from "./lib/daily-office-runner.js";
import { runStateChecks } from "./log-review/state-checks.js";
import { closeDatabaseConnections } from "../src/db/client.js";

const OUT_DIR = process.env["PROD_QA_OUT"] ?? "/tmp/founderos-prod-qa";
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");

interface ProbeRecord {
  id: string;
  input: string;
  status: string;
  toolsCalled: string[];
  guardKind?: string;
  validationError?: string;
  replySnippet: string;
  elapsedMs: number;
}

const PROBE_TASKS: StressTask[] = [
  {
    id: "T06-context",
    dept: "admin",
    expectHITL: false,
    input: "What do you know about me?",
    expectedTools: ["read_context"],
    validate: (reply, tools) => {
      if (!tools.some((t) => ["read_context", "search_memory", "search_knowledge"].includes(t))) {
        return "No memory tool called — parametric/stale memory reply";
      }
      if (/don't have|do not have|no (information|context)/i.test(reply) && reply.length < 120) {
        return "Refused despite read_context path";
      }
      return null;
    },
  },
  {
    id: "T02-research-handoff",
    dept: "research",
    expectHITL: false,
    input: "What's the latest news about LangGraph JS?",
    expectedTools: ["search_web"],
    validate: (reply) => {
      if (/cannot transfer back to supervisor/i.test(reply)) return "Research handoff stuck";
      if (reply.trim().length < 40) return "Empty/timeout reply";
      return null;
    },
  },
  {
    id: "T23-icp-grounding",
    dept: "knowledge",
    expectHITL: false,
    input: "What is Turicks ICP? Be specific with revenue bands and geography.",
    validate: (reply, tools, messages) => {
      const guard = detectGuardViolation(
        "What is Turicks ICP? Be specific with revenue bands and geography.",
        messages,
        reply,
      );
      if (guard) return `Execution guard would retry (${guard}) — ungrounded reply leaked`;
      if (/\$50[kK]?|\$500[kK]?|50,?000.*500,?000/i.test(reply) &&
          !/don't have|does not have|no (knowledge|entry)|brain:sync|turicks-brain has no/i.test(reply)) {
        return "Fabricated ICP revenue bands without turicks-brain citation";
      }
      return null;
    },
  },
  {
    id: "T24-icp-repeat",
    dept: "knowledge",
    expectHITL: false,
    input: "What is Turicks ICP? Be specific with revenue bands and geography.",
    repeatOnSameThread: true,
    validate: (reply, _tools, messages) => {
      const guard = detectGuardViolation(
        "What is Turicks ICP? Be specific with revenue bands and geography.",
        messages,
        reply,
      );
      if (guard) return `Stale checkpoint regurgitation (${guard})`;
      return null;
    },
  },
  {
    id: "T25-shell-hitl",
    dept: "shell",
    expectHITL: true,
    input: `Run this in terminal: echo "prod-hardcore-${Date.now()}"`,
    validate: (reply, tools, messages) => {
      if (detectGuardViolation(
        `Run this in terminal: echo "prod-hardcore"`,
        messages,
        reply,
      )) return null;
      if (!tools.includes("run_shell") && /\b(executed|stdout|here(?:'s| is) the output)\b/i.test(reply)) {
        return "Fake shell execution without run_shell";
      }
      return null;
    },
  },
];

function toRecord(r: StressResult): ProbeRecord {
  return {
    id: r.task.id,
    input: r.task.input,
    status: r.status,
    toolsCalled: r.toolsCalled,
    guardKind: r.guardKind,
    validationError: r.validationError,
    replySnippet: r.replySnippet.slice(0, 400),
    elapsedMs: r.elapsedMs,
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const started = Date.now();

  console.log(`\n${"=".repeat(72)}`);
  console.log("FounderOS PROD HARDCORE OFFICE PROBES");
  console.log(`${"=".repeat(72)}\n`);

  const stateFindings = await runStateChecks("turicks");
  console.log("==> DB state checks");
  for (const f of stateFindings) {
    console.log(`    [${f.severity}] ${f.summary}`);
  }

  const office = await getStressOffice();
  const records: ProbeRecord[] = [];
  let pass = 0;
  let fail = 0;

  for (const task of PROBE_TASKS) {
    const threadId = `prod-hardcore:${task.id}:${RUN_ID}`;
    console.log(`\n==> ${task.id}: ${task.input.slice(0, 60)}…`);

    if (task.repeatOnSameThread) {
      const { first, second } = await runStressTaskRepeat(office, task, threadId);
      for (const [label, result] of [["1st", first], ["2nd", second]] as const) {
        records.push(toRecord(result));
        const ok = stressResultOk(result) && !result.validationError;
        if (ok) {
          pass++;
          console.log(`    ✅ [${label}] ${result.status} tools=[${result.toolsCalled.join(",")}]`);
        } else {
          fail++;
          console.log(`    ❌ [${label}] ${result.validationError ?? result.error ?? result.status}`);
        }
      }
      continue;
    }

    const result = await runStressTask(office, task, threadId);
    records.push(toRecord(result));
    const ok = stressResultOk(result) && !result.validationError;
    if (ok) {
      pass++;
      console.log(`    ✅ ${result.status} tools=[${result.toolsCalled.join(",")}] ${result.elapsedMs}ms`);
    } else {
      fail++;
      console.log(`    ❌ ${result.status} ${result.validationError ?? result.error ?? ""}`);
      console.log(`       tools=[${result.toolsCalled.join(",")}] reply=${result.replySnippet.slice(0, 120)}`);
    }
  }

  const totalChecks = pass + fail;

  const report = {
    runId: RUN_ID,
    suite: "prod-hardcore-probes",
    elapsedMs: Date.now() - started,
    stateFindings,
    pass,
    fail,
    total: totalChecks,
    records,
  };

  const outPath = `${OUT_DIR}/hardcore-probes-${RUN_ID}.json`;
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n${"=".repeat(72)}`);
  console.log(`PROBES: ${pass}/${totalChecks} pass | report: ${outPath}`);
  console.log(`${"=".repeat(72)}\n`);

  await closeDatabaseConnections();
  process.exit(fail > 0 || stateFindings.some((f) => f.severity === "high") ? 1 : 0);
}

main().catch(async (err) => {
  console.error("prod-hardcore-probes fatal:", err);
  await closeDatabaseConnections().catch(() => {});
  process.exit(1);
});
