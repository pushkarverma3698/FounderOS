/**
 * Deterministic State & Artifact Delivery Tools (Phase 2 & Phase 3)
 *   job_state       — deterministic query of job_applications table
 *   ops_state       — deterministic query of system operational tables
 *   write_artifact  — write persistent deliverables under ARTIFACT_ROOT (md, csv, json, txt)
 *   deliver_artifact— deliver generated artifact to Telegram as file attachment (HITL-gated)
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { jobStateTool } from "../../tools/job-state.js";
import { opsStateTool } from "../../tools/ops-state.js";
import { writeArtifactTool, writeArtifactFile, type ArtifactFormat } from "../../tools/artifact.js";
import { deliverArtifactTool, deliverArtifactFile } from "../../tools/deliver-artifact.js";
import { hitlGate } from "./hitl.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "agent-tools:state" });

export const jobState = tool(
  async ({ stage, section, source, applied, since, fullDetails, limit }) => {
    const res = await jobStateTool.execute({
      ...(stage ? { stage } : {}),
      ...(section ? { section } : {}),
      ...(source ? { source } : {}),
      ...(typeof applied === "boolean" ? { applied } : {}),
      ...(since ? { since } : {}),
      ...(typeof fullDetails === "boolean" ? { fullDetails } : {}),
      ...(typeof limit === "number" ? { limit } : {}),
    });
    if (!res.success) return `job_state failed: ${res.error}`;
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  },
  {
    name: "job_state",
    description: jobStateTool.description,
    schema: z.object({
      stage: z.string().optional().nullable().describe("Filter by stage (e.g. 'screened', 'applied', 'rejected')."),
      section: z.string().optional().nullable().describe("Filter by brief section."),
      source: z.string().optional().nullable().describe("Filter by route/source."),
      applied: z.boolean().optional().nullable().describe("Filter applied status."),
      since: z.string().optional().nullable().describe("Filter created_at >= ISO string."),
      fullDetails: z.boolean().optional().nullable().describe("Include all DB columns."),
      limit: z.number().optional().nullable().describe("Max rows to return (default 50, max 200)."),
    }),
  },
);

export const opsState = tool(
  async ({ scope, status, since, limit }) => {
    const res = await opsStateTool.execute({
      scope,
      ...(status ? { status } : {}),
      ...(since ? { since } : {}),
      ...(typeof limit === "number" ? { limit } : {}),
    });
    if (!res.success) return `ops_state failed: ${res.error}`;
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  },
  {
    name: "ops_state",
    description: opsStateTool.description,
    schema: z.object({
      scope: z.enum(["scheduled_tasks", "reminders", "hitl_approvals", "action_log", "costs"]).describe("Operational scope to query."),
      status: z.string().optional().nullable().describe("Filter by status."),
      since: z.string().optional().nullable().describe("Filter timestamp >= ISO string."),
      limit: z.number().optional().nullable().describe("Max rows to return (default 50, max 200)."),
    }),
  },
);

export const writeArtifact = tool(
  async ({ id, title, content, format }, config) => {
    try {
      const threadId = (config?.configurable?.thread_id as string | undefined) ?? "default";
      const result = await writeArtifactFile(
        {
          id,
          title: title ?? undefined,
          content,
          format: (format as ArtifactFormat | undefined) ?? "md",
        },
        threadId,
      );

      return `✅ Artifact "${id}" (${result.bytes} bytes, format: ${result.format}) written successfully to ${result.path}`;
    } catch (err) {
      log.error({ err: String(err) }, "Failed to write artifact");
      return `❌ Failed to write artifact: ${(err as Error).message}`;
    }
  },
  {
    name: "write_artifact",
    description: writeArtifactTool.description,
    schema: z.object({
      id: z.string().describe("Unique identifier for the artifact (e.g. jobs_export, competitor_analysis)"),
      title: z.string().optional().nullable().describe("Optional title for markdown artifacts"),
      content: z.string().describe("Content of the artifact"),
      format: z.enum(["md", "csv", "json", "txt"]).optional().nullable().describe("Format: md | csv | json | txt"),
    }),
  },
);

export const deliverArtifact = tool(
  async ({ path: filePath, caption }, config) => {
    try {
      const rejected = await hitlGate(
        {
          action: "deliver_artifact",
          title: `📄 Deliver artifact to Telegram?`,
          summary: `Deliver artifact at ${filePath}`,
          preview: filePath,
          args: { path: filePath },
        },
        config,
      );
      if (rejected) return rejected;

      const result = await deliverArtifactFile({
        path: filePath,
        caption: caption ?? undefined,
      });

      return `✅ Artifact "${result.filename}" (${result.bytes} bytes) delivered successfully to Telegram.`;
    } catch (err) {
      log.error({ err: String(err) }, "Failed to deliver artifact");
      return `❌ Failed to deliver artifact: ${(err as Error).message}`;
    }
  },
  {
    name: "deliver_artifact",
    description: deliverArtifactTool.description,
    schema: z.object({
      path: z.string().describe("Absolute path to the artifact file under ARTIFACT_ROOT"),
      caption: z.string().optional().nullable().describe("Optional caption for Telegram attachment"),
    }),
  },
);
