/**
 * Manual E2E — Cinematic Launch Experience / web design service wiring.
 * Exercises REAL paths: contracts → DB → scheduler formatters → live office routing.
 *
 * Run: node --env-file=.env --import tsx/esm scripts/e2e-web-design-manual.ts
 */
import { MemorySaver } from "@langchain/langgraph";
import { HumanMessage } from "@langchain/core/messages";
import { validateSignalPayload } from "../src/agents/contracts.js";
import { prepareSignal } from "../src/agents/agent-tools/signals.js";
import {
  formatDesignBriefNudge,
  formatSiteDeployedNudge,
} from "../src/infra/scheduler.js";
import { publishDeptEventWithAudit, countDeptSignals } from "../src/db/queries.js";
import { TENANT } from "../src/core/config.js";
import { buildOffice, getPendingApproval } from "../src/agents/office.js";
import { findClaudeBinary } from "../src/tools/claude-code.js";
import {
  executeDeployStaticSite,
  buildPublicUrl,
  isValidDeploySlug,
} from "../src/tools/deploy-static-site.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { GOLDEN_TASKS } from "../src/eval/golden-tasks.js";
import { makeOfficeInvoker } from "../src/eval/office-invoker.js";
import { runEval } from "../src/eval/runner.js";
import { closeDatabaseConnections } from "../src/db/client.js";
import { getConfiguredModelId, DEFAULT_AGENT_MODEL } from "../src/agents/model.js";

type Check = { name: string; ok: boolean; detail: string };

const checks: Check[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}\n   ${detail}\n`);
}

async function testSignalContracts(): Promise<void> {
  const brief = validateSignalPayload("design_brief_ready", {
    client: "AgentOps",
    preset: "neon",
    copyBlocks: { hero: "Ship agents you can trust" },
  });
  record(
    "contract: design_brief_ready validates",
    brief.ok,
    brief.ok ? "payload accepted" : (brief as { error: string }).error,
  );

  const deployed = validateSignalPayload("site_deployed", {
    client: "AgentOps",
    siteUrl: "https://agentops.example.com",
    presetUsed: "neon",
  });
  record(
    "contract: site_deployed validates",
    deployed.ok,
    deployed.ok ? "payload accepted" : (deployed as { error: string }).error,
  );

  const bad = validateSignalPayload("site_deployed", { client: "X" });
  record(
    "contract: site_deployed rejects missing siteUrl",
    !bad.ok,
    bad.ok ? "unexpected pass" : (bad as { error: string }).error,
  );
}

async function testSignalDbRoundTrip(): Promise<void> {
  const prepared = prepareSignal(
    "design_brief_ready",
    { client: "E2E-Manual", preset: "glass", copyBlocks: { hero: "test" } },
    { fromDept: "marketing" },
  );
  if (!prepared.ok) {
    record("db: design_brief_ready publish", false, prepared.error);
    return;
  }

  const idem = `e2e-webdesign-brief-${Date.now()}`;
  const countBefore = await countDeptSignals(TENANT);
  const { signalId } = await publishDeptEventWithAudit(
    { tenant_id: TENANT, ...prepared.signal, consumed: false },
    {
      tenant_id: TENANT,
      action: "signal_published",
      idempotency_key: idem,
      payload: { event_type: "design_brief_ready", e2e: true },
    },
  );
  const countAfter = await countDeptSignals(TENANT);
  record(
    "db: design_brief_ready persisted + audit",
    Boolean(signalId) && countAfter === countBefore + 1,
    `signalId=${signalId} count ${countBefore}→${countAfter}`,
  );

  const nudge = formatDesignBriefNudge([
    {
      id: signalId,
      tenant_id: TENANT,
      from_dept: "marketing",
      to_dept: "engineering",
      event_type: "design_brief_ready",
      payload: prepared.signal.payload,
      thread_id: null,
      consumed: false,
      created_at: new Date(),
    } as never,
  ]);
  record(
    "scheduler: design_brief nudge renders",
    nudge.includes("E2E-Manual") && nudge.includes("glass"),
    nudge.slice(0, 120).replace(/\n/g, " "),
  );

  const sitePrep = prepareSignal(
    "site_deployed",
    {
      client: "E2E-Manual",
      siteUrl: "https://e2e-manual.example.com",
      presetUsed: "glass",
    },
    { fromDept: "engineering" },
  );
  if (!sitePrep.ok) {
    record("scheduler: site_deployed prepare", false, sitePrep.error);
    return;
  }
  const siteNudge = formatSiteDeployedNudge([
    {
      event_type: "site_deployed",
      payload: sitePrep.signal.payload,
    } as never,
  ]);
  record(
    "scheduler: site_deployed nudge renders",
    siteNudge.includes("e2e-manual.example.com"),
    siteNudge.slice(0, 120).replace(/\n/g, " "),
  );
}

async function testLiveRouting(taskId: string): Promise<void> {
  const task = GOLDEN_TASKS.find((t) => t.id === taskId);
  if (!task) {
    record(`routing: ${taskId}`, false, "task not in golden set");
    return;
  }

  const office = buildOffice(new MemorySaver());
  const threadId = `e2e:${taskId}:${Date.now()}`;
  const invoke = makeOfficeInvoker(office as never, getPendingApproval as never);
  const report = await runEval([task], invoke, { taskDelayMs: 500 });
  const r = report.results[0]!;
  const obs = r.observation;
  const failReasons: string[] = [];
  if (!r.routeCorrect) failReasons.push(`route expected ${task.expectedRoute} got ${obs.route ?? "none"}`);
  if (!r.toolsCorrect) failReasons.push(`tools expected [${(task.expectedTools ?? []).join(",")}] got [${obs.tools.join(",")}]`);
  if (!r.hitlCorrect) failReasons.push(`hitl expected ${task.expectsHitl ?? "n/a"} got ${obs.hadInterrupt}`);
  if (obs.error) failReasons.push(`error: ${obs.error}`);
  record(
    `routing: ${taskId} → ${task.expectedRoute}`,
    r.passed,
    `route=${obs.route ?? "none"} tools=[${obs.tools.join(",")}] hitl=${obs.hadInterrupt} ${r.passed ? "PASS" : failReasons.join("; ")}`,
  );
}

async function testDeployTool(): Promise<void> {
  record("deploy: slug validation", isValidDeploySlug("showcase-1"), "showcase-1 accepted");
  const prevForce = process.env["DEPLOY_STATIC_SITE_FORCE_HOME"];
  const prevHome = process.env["STATIC_SITE_HOME_ROOT"];
  const prevBase = process.env["STATIC_SITE_PUBLIC_BASE_URL"];
  const prevProjects = process.env["PROJECT_WORKFLOW_ROOT"];
  const tmpHome = mkdtempSync(join("/tmp", "e2e-www-"));
  const projectsBase = mkdtempSync(join("/tmp", "e2e-projects-"));
  process.env["PROJECT_WORKFLOW_ROOT"] = projectsBase;
  const srcDir = mkdtempSync(join(projectsBase, "e2e-deploy-"));
  process.env["DEPLOY_STATIC_SITE_FORCE_HOME"] = "1";
  process.env["STATIC_SITE_HOME_ROOT"] = tmpHome;
  process.env["STATIC_SITE_PUBLIC_BASE_URL"] = "http://e2e.test";
  writeFileSync(join(srcDir, "index.html"), "<html><title>E2E Deploy</title></html>");
  try {
    const res = executeDeployStaticSite({ slug: "e2e-client", sourcePath: join(srcDir, "index.html") });
    const ok = res.success && (res.data as { publicUrl: string }).publicUrl === buildPublicUrl("e2e-client");
    record("deploy: home-mode copy + public URL", ok, ok ? (res.data as { publicUrl: string }).publicUrl : String(res.error));
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(projectsBase, { recursive: true, force: true });
    if (prevForce === undefined) delete process.env["DEPLOY_STATIC_SITE_FORCE_HOME"];
    else process.env["DEPLOY_STATIC_SITE_FORCE_HOME"] = prevForce;
    if (prevHome === undefined) delete process.env["STATIC_SITE_HOME_ROOT"];
    else process.env["STATIC_SITE_HOME_ROOT"] = prevHome;
    if (prevBase === undefined) delete process.env["STATIC_SITE_PUBLIC_BASE_URL"];
    else process.env["STATIC_SITE_PUBLIC_BASE_URL"] = prevBase;
    if (prevProjects === undefined) delete process.env["PROJECT_WORKFLOW_ROOT"];
    else process.env["PROJECT_WORKFLOW_ROOT"] = prevProjects;
  }
}

async function testEngineeringHitl(): Promise<void> {
  const office = buildOffice(new MemorySaver());
  const config = {
    configurable: { thread_id: `e2e:eng-build:${Date.now()}` },
    recursionLimit: 25,
  };
  let threw = false;
  try {
    await office.invoke(
      {
        messages: [
          new HumanMessage(
            "Build a cinematic landing page for a fictional AI observability startup called AgentOps using the neon preset.",
          ),
        ],
      },
      config,
    );
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    record(
      "engineering: build landing completes without recursion crash",
      false,
      msg.slice(0, 200),
    );
    return;
  }
  const approval = await getPendingApproval(office, config);
  const action = (approval as { action?: string } | null)?.action ?? "none";
  const claudeOnHost = findClaudeBinary() !== null;
  record(
    "engineering: build landing triggers claude_code HITL",
    action === "claude_code",
    `approval action=${action} claudeCli=${claudeOnHost ? "installed" : "missing-on-host"}`,
  );
}

async function main(): Promise<void> {
  console.log("\n🔬 Manual E2E — Web Design Service\n");

  const modelId = getConfiguredModelId();
  const deprecated = /preview-05-20|gpt-4o-mini/i.test(modelId);
  record(
    "env: AGENT_MODEL is production-capable",
    !deprecated,
    deprecated
      ? `${modelId} is deprecated/weak — set AGENT_MODEL=${DEFAULT_AGENT_MODEL}`
      : modelId,
  );

  await testSignalContracts();
  await testSignalDbRoundTrip();
  await testDeployTool();

  const routingTasks = [
    "webdesign-research-leads",
    "webdesign-proof-drop-outreach",
    "webdesign-build-landing",
  ] as const;

  for (const id of routingTasks) {
    await testLiveRouting(id);
  }

  await testEngineeringHitl();

  const failed = checks.filter((c) => !c.ok);
  console.log("═".repeat(60));
  console.log(`Results: ${checks.length - failed.length}/${checks.length} passed`);
  if (failed.length) {
    console.log("Failed:", failed.map((f) => f.name).join(", "));
    process.exitCode = 1;
  } else {
    console.log("All manual E2E checks passed.");
  }
}

main()
  .catch((err) => {
    console.error("E2E harness failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabaseConnections().catch(() => {});
    setTimeout(() => process.exit(process.exitCode ?? 0), 300);
  });
