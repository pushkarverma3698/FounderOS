/**
 * FounderOS — deliver_artifact Tool
 * ==================================
 * Delivers a generated deliverable/artifact from ARTIFACT_ROOT to the founder's Telegram.
 * Enforces path confinement under ARTIFACT_ROOT and stat verification before sending.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ARTIFACT_ROOT } from "../core/config.js";
import { sendDocument } from "../infra/telegram-send.js";
import { childLogger } from "../infra/logger.js";
import type { UnifiedTool, ToolResult } from "./index.js";

const log = childLogger({ module: "tool:deliver-artifact" });

export interface DeliverArtifactArgs {
  readonly path: string;
  readonly caption?: string;
}

export async function deliverArtifactFile(
  args: DeliverArtifactArgs,
  artifactRoot: string = ARTIFACT_ROOT,
): Promise<{ path: string; bytes: number; filename: string }> {
  const normRoot = path.normalize(path.resolve(artifactRoot));
  const normPath = path.normalize(path.resolve(args.path));

  if (normPath !== normRoot && !normPath.startsWith(normRoot + path.sep)) {
    throw new Error(`Access denied: artifact path ${args.path} is outside ARTIFACT_ROOT (${normRoot}).`);
  }

  const stats = await fs.stat(normPath);
  if (stats.size === 0) {
    throw new Error(`Refused delivery: artifact at ${normPath} is 0 bytes.`);
  }

  const filename = path.basename(normPath);
  await sendDocument(normPath, filename, {
    caption: args.caption ?? `📄 Deliverable: ${filename} (${stats.size} bytes)`,
  });

  log.info({ path: normPath, bytes: stats.size, filename }, "Artifact delivered to Telegram");

  return {
    path: normPath,
    bytes: stats.size,
    filename,
  };
}

export const deliverArtifactTool: UnifiedTool = {
  name: "deliver_artifact",
  description:
    "Deliver a generated artifact/file from ARTIFACT_ROOT to the founder's Telegram chat as an attachment. " +
    "Path must be within ARTIFACT_ROOT. Stat-verified before sending. HITL-gated (outbound delivery).",

  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the artifact file under ARTIFACT_ROOT" },
      caption: { type: "string", description: "Optional caption for the Telegram attachment" },
    },
    required: ["path"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const rawPath = args["path"] as string | undefined;
    if (!rawPath) {
      return { success: false, error: "deliver_artifact requires a path argument." };
    }

    try {
      const result = await deliverArtifactFile({
        path: rawPath,
        caption: args["caption"] as string | undefined,
      });

      return {
        success: true,
        data: JSON.stringify(result, null, 2),
      };
    } catch (err) {
      return {
        success: false,
        error: `Failed to deliver artifact: ${(err as Error).message}`,
      };
    }
  },
};
