/**
 * FounderOS — Artifact Management System
 * ========================================
 * Implements tools to create and update persistent deliverables under ARTIFACT_ROOT.
 * Formats supported: md, csv, json, txt.
 * Stat-verified after write; fails loudly on 0-byte output.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ARTIFACT_ROOT } from "../core/config.js";
import { childLogger } from "../infra/logger.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:artifact" });

export type ArtifactFormat = "md" | "csv" | "json" | "txt";

export interface WriteArtifactArgs {
  readonly id: string;
  readonly title?: string;
  readonly content: string;
  readonly format?: ArtifactFormat;
}

export async function writeArtifactFile(
  args: WriteArtifactArgs,
  threadId: string = "default",
  artifactRoot: string = ARTIFACT_ROOT,
): Promise<{ path: string; bytes: number; format: ArtifactFormat; id: string }> {
  const safeThreadId = threadId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const safeId = args.id.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const format: ArtifactFormat = args.format ?? "md";
  const ext = format === "json" ? "json" : format === "csv" ? "csv" : format === "txt" ? "txt" : "md";

  const threadDir = path.join(artifactRoot, safeThreadId);
  await fs.mkdir(threadDir, { recursive: true });

  const filePath = path.join(threadDir, `${safeId}.${ext}`);
  const fileContent = format === "md" && args.title && !args.content.startsWith("#")
    ? `# ${args.title}\n\n${args.content}`
    : args.content;

  await fs.writeFile(filePath, fileContent, "utf-8");
  const stats = await fs.stat(filePath);

  if (stats.size === 0) {
    throw new Error(`Artifact write failed: produced 0 bytes at ${filePath}`);
  }

  log.info({ threadId, id: args.id, filePath, bytes: stats.size, format }, "Artifact written & stat verified");

  return {
    path: filePath,
    bytes: stats.size,
    format,
    id: args.id,
  };
}

export const writeArtifactTool: UnifiedTool = {
  name: "write_artifact",
  description:
    "Write a persistent structured artifact (research notes, CSV export, drafts, JSON data) for the founder under ARTIFACT_ROOT. " +
    "Supports format: 'md' | 'csv' | 'json' | 'txt'. Verified by stat post-write.",

  input_schema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Unique identifier for the artifact (e.g. jobs_export, competitor_analysis)" },
      title: { type: "string", description: "Optional title for markdown artifacts" },
      content: { type: "string", description: "Content of the artifact" },
      format: { type: "string", enum: ["md", "csv", "json", "txt"], description: "File format (default: 'md')" },
    },
    required: ["id", "content"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const id = args["id"] as string | undefined;
    const content = args["content"] as string | undefined;
    if (!id || !content) {
      return { success: false, error: "write_artifact requires id and content." };
    }

    try {
      const result = await writeArtifactFile({
        id,
        title: args["title"] as string | undefined,
        content,
        format: args["format"] as ArtifactFormat | undefined,
      });

      return {
        success: true,
        data: JSON.stringify(result, null, 2),
        observed: {
          kind: "file",
          evidence: `${result.path}:${result.bytes}`,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to write artifact: ${(err as Error).message}`,
      };
    }
  },
};

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
    description: "Write a persistent structured artifact (notes, CSV exports, reports, JSON) for the founder.",
    schema: z.object({
      id: z.string().describe("Unique identifier for the artifact (e.g. jobs_export, competitor_analysis)"),
      title: z.string().optional().nullable().describe("Optional title for markdown artifacts"),
      content: z.string().describe("Content of the artifact"),
      format: z.enum(["md", "csv", "json", "txt"]).optional().nullable().describe("Format: md | csv | json | txt"),
    }),
  },
);
