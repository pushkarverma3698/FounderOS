/**
 * FounderOS — Artifact Management System
 * ========================================
 * Implements tools to create and update persistent deliverables under the workspace artifacts directory.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "tool:artifact" });

const ARTIFACTS_ROOT = path.resolve("./artifacts");

async function ensureDir(dirPath: string) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    if ((err as any).code !== "EEXIST") throw err;
  }
}

export const writeArtifact = tool(
  async ({ id, title, content }, config) => {
    try {
      const threadId = config?.configurable?.thread_id ?? "default";
      // Sanitize names to prevent directory traversal
      const safeThreadId = threadId.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const safeId = id.replace(/[^a-zA-Z0-9_.-]/g, "_");
      
      const threadDir = path.join(ARTIFACTS_ROOT, safeThreadId);
      await ensureDir(threadDir);
      
      const filePath = path.join(threadDir, `${safeId}.md`);
      const fileContent = `# ${title}\n\n${content}`;
      
      await fs.writeFile(filePath, fileContent, "utf-8");
      log.info({ threadId, id, filePath }, "Artifact written successfully");
      return `✅ Artifact "${title}" (ID: ${id}) written successfully.`;
    } catch (err) {
      log.error({ err: String(err) }, "Failed to write artifact");
      return `❌ Failed to write artifact: ${(err as Error).message}`;
    }
  },
  {
    name: "write_artifact",
    description: "Write a persistent structured artifact (research notes, drafts, reports) for the founder.",
    schema: z.object({
      id: z.string().describe("Unique identifier for the artifact (e.g. competitor_analysis, marketing_plan)"),
      title: z.string().describe("Human-readable title of the artifact"),
      content: z.string().describe("Markdown content of the artifact"),
    }),
  }
);
