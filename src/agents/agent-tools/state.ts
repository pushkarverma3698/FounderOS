/**
 * Deterministic State & Artifact Delivery Tools (Phase 2 & Phase 3)
 *   job_state       — deterministic query of job_applications table
 *   ops_state       — deterministic query of system operational tables
 *   export_jobs_csv — job rows → CSV file, serialised in code (never model prose)
 *   write_artifact  — write persistent deliverables under ARTIFACT_ROOT (md, csv, json, txt)
 *   deliver_artifact— deliver generated artifact to Telegram as file attachment (HITL-gated)
 */

import { basename } from "node:path";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { jobStateTool } from "../../tools/job-state.js";
import { exportJobsCsvTool } from "../../tools/jobhunt/jobs-csv.js";
import { opsStateTool } from "../../tools/ops-state.js";
import { writeArtifactTool, writeArtifactFile, type ArtifactFormat } from "../../tools/artifact.js";
import { deliverArtifactTool, deliverArtifactFile } from "../../tools/deliver-artifact.js";
import { hitlGate } from "./hitl.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "agent-tools:state" });

/**
 * `profile` and `track` are NOT optional extras on this schema.
 *
 * job_state's description instructs the worker to pass `profile` whenever a
 * question names a candidate, and to "never answer for a named candidate using
 * data you did not explicitly filter to their profile". Until 2026-09-08 this
 * schema had no `profile` field, which made that instruction impossible to
 * obey — the argument was unrepresentable, so every named-candidate question
 * silently ran against the default queue. `track` is the same class of gap from
 * the other direction: it is the column `job_brief` prints, so it is the filter
 * a founder's follow-up question is phrased in.
 */
export const jobState = tool(
  async ({ profile, stage, section, track, source, applied, since, fullDetails, limit }) => {
    const res = await jobStateTool.execute({
      ...(profile ? { profile } : {}),
      ...(stage ? { stage } : {}),
      ...(section ? { section } : {}),
      ...(track ? { track } : {}),
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
      profile: z
        .string()
        .optional()
        .nullable()
        .describe(
          "REQUIRED when the question names a candidate ('Tashi', 'my wife', 'Pushkar'). " +
            "A profile id, a first name, or 'all'. Omitting it means the founder's own queue.",
        ),
      stage: z.string().optional().nullable().describe("Filter by stage (e.g. 'screened', 'applied', 'rejected')."),
      section: z
        .string()
        .optional()
        .nullable()
        .describe("Brief PRIORITY BUCKET: do_today | stretch | ask | standing. Not the role kind — that is `track`."),
      track: z
        .string()
        .optional()
        .nullable()
        .describe("Role CLASSIFICATION, the column job_brief prints ('accountant 4 · fpa 7 · auditor 1')."),
      source: z.string().optional().nullable().describe("Filter by route/source."),
      applied: z.boolean().optional().nullable().describe("Filter applied status."),
      since: z.string().optional().nullable().describe("Filter created_at >= ISO string."),
      fullDetails: z.boolean().optional().nullable().describe("Include all DB columns."),
      limit: z.number().optional().nullable().describe("Max rows to return (default 50, max 200)."),
    }),
  },
);

/**
 * The jobs CSV, written by code.
 *
 * Deliberately placed beside write_artifact rather than in jobhunt.ts: it is
 * the artifact-PRODUCTION path for job rows, and the whole point is that it
 * replaces `write_artifact(content: <CSV the model typed>)` for this one
 * payload. See jobs-csv.ts for the two prod exports that made it necessary.
 */
export const exportJobsCsv = tool(
  async ({ profile, kind, stage, section, track, applied, since, limit, id }, config) => {
    const threadId = (config?.configurable?.thread_id as string | undefined) ?? "default";
    const res = await exportJobsCsvTool.execute(
      {
        ...(profile ? { profile } : {}),
        ...(kind ? { kind } : {}),
        ...(stage ? { stage } : {}),
        ...(section ? { section } : {}),
        ...(track ? { track } : {}),
        ...(typeof applied === "boolean" ? { applied } : {}),
        ...(since ? { since } : {}),
        ...(typeof limit === "number" ? { limit } : {}),
        ...(id ? { id } : {}),
      },
      { threadId },
    );
    if (!res.success) return `export_jobs_csv failed: ${res.error}`;
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  },
  {
    name: "export_jobs_csv",
    description: exportJobsCsvTool.description,
    schema: z.object({
      profile: z.string().optional().nullable().describe("Candidate: profile id, first name, or 'all'."),
      kind: z
        .enum(["queue", "log"])
        .optional()
        .nullable()
        .describe("'log' (default) = everything screened with links; 'queue' = ranked shortlist only."),
      stage: z.string().optional().nullable().describe("Filter by stage."),
      section: z.string().optional().nullable().describe("Brief bucket: do_today | stretch | ask | standing."),
      track: z.string().optional().nullable().describe("Role classification (e.g. 'accountant', 'fpa', 'ai')."),
      applied: z.boolean().optional().nullable().describe("true = applied only, false = not yet applied."),
      since: z.string().optional().nullable().describe("Rows discovered on/after this ISO timestamp."),
      limit: z.number().optional().nullable().describe("Max rows (default 200)."),
      id: z.string().optional().nullable().describe("Filename stem (default: jobs_export)."),
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
      scope: z
        .enum(["scheduled_tasks", "reminders", "hitl_approvals", "action_log", "costs", "job_runs"])
        .describe(
          "Operational scope. 'costs' = money spent on AI calls (dollar totals + per-model breakdown) — " +
            "use it for any spend/budget/cost question. 'job_runs' = job sweep throughput counts.",
        ),
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
    const rejected = await hitlGate(
      {
        action: "deliver_artifact",
        title: `📄 Send you this file?`,
        // The card is founder-facing: name the file, not the server layout.
        // `args` still carries the full path — that is the internal record the
        // resume path re-executes from, and it is not rendered on the card.
        summary: `Send "${basename(filePath)}" to this chat`,
        preview: basename(filePath),
        args: { path: filePath },
      },
      config,
    );
    if (rejected) return rejected;

    try {
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
