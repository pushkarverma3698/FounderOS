/**
 * Engineering department — vps_run wrapper (WRITE, HITL-gated).
 * ==============================================================
 * LangChain wrapper for the VPS containerized job runner
 * (src/tools/vps-run.ts — spec 2026-07-14 §3.3, follow-up item 11).
 * Own file rather than engineering.ts: that module already exceeds the
 * 400-line budget (R4) and may only shrink.
 *
 * Ordering pinned by the HITL contract: idempotency check → hitlGate →
 * side effect → audit row only on real success.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { vpsRunTool, VPS_RUN_PROFILE, type VpsRunData } from "../../tools/vps-run.js";
import { childLogger } from "../../infra/logger.js";
import { hitlGate, idemKey } from "./hitl.js";
import { toolFailure } from "../tool-result.js";
import { hasBeenAudited, writeAuditEntry, recordWorkflowRun } from "../../db/queries.js";
import { slugifyWorkflow, workflowSignature } from "../../tools/workflow-catalog.js";
import { TENANT } from "../../core/config.js";

const log = childLogger({ module: "agent-tools:vps-run" });

export const vpsRun = tool(
  async ({ command, brief, image, network, timeout_minutes }, config) => {
    // Idempotency keys off the founder-approved inputs; run_id is generated
    // inside the tool, so it cannot participate without breaking resume replay.
    const key = idemKey("vps_run", command, brief ?? "", image ?? "");
    if (await hasBeenAudited(key)) {
      return `Already ran this exact VPS job (skipped duplicate run).`;
    }

    const rejected = await hitlGate({
      action: "vps_run",
      title: "🐳 Run containerized job on the VPS?",
      summary: `image: ${image ?? VPS_RUN_PROFILE.defaultImage} · network: ${network ?? "none"} · timeout: ${timeout_minutes ?? VPS_RUN_PROFILE.defaultTimeoutMinutes}m`,
      preview: brief ? `${command}\n---\n${brief.slice(0, 400)}` : command,
      args: { command, brief, image, network, timeout_minutes },
    }, config);
    if (rejected) return rejected;

    const res = await vpsRunTool.execute({
      command,
      ...(brief ? { brief } : {}),
      ...(image ? { image } : {}),
      ...(network ? { network } : {}),
      ...(timeout_minutes != null ? { timeout_minutes } : {}),
    });
    const data = res.data as VpsRunData | undefined;
    if (!res.success) {
      // Partial outputs are evidence — surface their S3 keys even on failure.
      const kept = data?.artifacts.length ? `\nPartial outputs kept: ${data.artifacts.map((a) => a.s3_key).join(", ")}` : "";
      const tail = data?.stdout_tail ? `\nstdout tail:\n${data.stdout_tail.slice(-800)}` : "";
      return toolFailure("external_api", `vps_run failed: ${res.error}${kept}${tail}`);
    }

    await writeAuditEntry({
      action: "vps_run",
      idempotency_key: key,
      payload: { command: command.slice(0, 400), run_id: data!.run_id, artifacts: data!.artifacts.length },
      tenant_id: TENANT,
    });
    // Catalog the workflow so it's findable/re-runnable tomorrow. Best-effort:
    // the job already succeeded and its outputs are durable in S3 — a catalog
    // write must never turn that into a failure.
    // allow-failopen: workflow cataloging is an index, never a dependency
    await recordWorkflowRun({
      tenant_id: TENANT,
      slug: slugifyWorkflow(command, brief ?? undefined),
      signature: workflowSignature("vps_run", command, image ?? undefined),
      tool: "vps_run",
      command,
      ...(brief ? { brief } : {}),
      ...(image ? { image } : {}),
      s3_keys: data!.artifacts.map((a) => a.s3_key),
      last_run_id: data!.run_id,
    }).catch((err) => log.warn({ err: String(err) }, "vps_run: workflow catalog write failed (non-fatal)"));

    log.info({ run_id: data!.run_id }, "vps_run executed via engineering agent");
    const artifactLines = data!.artifacts.map((a) => `   - ${a.path} → s3://${a.s3_key} (${a.bytes} bytes)`).join("\n");
    return (
      `✅ VPS job ${data!.run_id} completed (exit 0).\n` +
      (artifactLines ? `Artifacts uploaded:\n${artifactLines}\n` : "No output files were produced.\n") +
      (data!.stdout_tail ? `stdout tail:\n${data!.stdout_tail.slice(-800)}` : "")
    );
  },
  {
    name: "vps_run",
    description: vpsRunTool.description,
    schema: z.object({
      command: z.string().describe("Shell command to run inside the container at /work (files written to /work are uploaded to S3)"),
      brief: z.string().optional().nullable().describe("Optional context written to /work/BRIEF.md before the command runs"),
      image: z.enum(["node:22-bookworm-slim", "python:3.12-slim", "ubuntu:24.04"]).optional().nullable(),
      network: z.enum(["none", "bridge"]).optional().nullable().describe("Default none; bridge only for jobs that must fetch or install packages"),
      timeout_minutes: z.number().optional().nullable().describe("Hard cap 30 (default 10)"),
    }),
  },
);
