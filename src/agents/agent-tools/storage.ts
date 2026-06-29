/**
 * FounderOS — Storage Tools (agent interface)
 * =============================================
 * LangChain @tool wrappers that give ReAct agents access to S3 asset storage.
 * Agents MUST use these tools — never call the S3 client or asset repo directly.
 *
 * All tools are read-only at the data level (upload writes S3 + Postgres, but
 * the content never enters LangGraph state). No HITL gate — uploads/downloads
 * are treated as internal operations equivalent to file reads.
 *
 * Trace seam events (tool.call / tool.result) are captured automatically by
 * TraceCallback when these tools are invoked inside a LangGraph graph.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  uploadFile,
  downloadFile,
  generatePresignedUrl,
  StorageError,
} from "../../infra/storage/s3-client.js";
import {
  saveAsset,
  getAssetsForRun,
} from "../../infra/storage/asset-repo.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "agent-tool:storage" });

// ── upload_asset ──────────────────────────────────────────────────────────────

export const uploadAsset = tool(
  async ({ file_bytes_b64, filename, run_id, asset_type, mime_type, agent_id }) => {
    let buf: Buffer;
    try {
      buf = Buffer.from(file_bytes_b64, "base64");
    } catch {
      return "upload_asset failed: file_bytes_b64 is not valid base64.";
    }

    let s3Key: string;
    try {
      s3Key = await uploadFile(buf, filename, run_id);
    } catch (err) {
      if (err instanceof StorageError) {
        log.error({ err: err.message, s3Key: err.s3Key }, "upload_asset: S3 error");
        return `upload_asset failed: ${err.message}`;
      }
      return `upload_asset failed: ${(err as Error).message}`;
    }

    let assetId: string;
    try {
      assetId = await saveAsset({
        run_id,
        s3_key: s3Key,
        original_filename: filename,
        asset_type: asset_type ?? "output",
        mime_type: mime_type ?? null,
        agent_id: agent_id ?? null,
        expires_at: null,
      });
    } catch (err) {
      log.error({ s3Key, err }, "upload_asset: DB record failed (file is in S3)");
      return `upload_asset: file uploaded to S3 (key=${s3Key}) but DB record failed: ${(err as Error).message}`;
    }

    return JSON.stringify({ asset_id: assetId, s3_key: s3Key });
  },
  {
    name: "upload_asset",
    description:
      "Upload a file to S3 asset storage and record it in the asset registry. " +
      "Accepts base64-encoded file bytes. Returns { asset_id, s3_key }. " +
      "Use get_download_url to generate a presigned download link afterwards.",
    schema: z.object({
      file_bytes_b64: z.string().describe("Base64-encoded file content"),
      filename: z.string().describe("Original filename, e.g. 'report.pdf'"),
      run_id: z.string().describe("LangGraph run ID this file belongs to"),
      asset_type: z
        .enum(["input", "output", "scratch"])
        .optional()
        .nullable()
        .describe("Asset category (default: output)"),
      mime_type: z
        .string()
        .optional()
        .nullable()
        .describe("MIME type, e.g. 'application/pdf'"),
      agent_id: z
        .string()
        .optional()
        .nullable()
        .describe("Uploading agent identifier, e.g. 'personal'"),
    }),
  },
);

// ── get_download_url ──────────────────────────────────────────────────────────

export const getDownloadUrl = tool(
  async ({ s3_key, ttl_seconds }) => {
    try {
      const url = await generatePresignedUrl(s3_key, ttl_seconds ?? 3600);
      return url;
    } catch (err) {
      if (err instanceof StorageError) {
        return `get_download_url failed: ${err.message}`;
      }
      return `get_download_url failed: ${(err as Error).message}`;
    }
  },
  {
    name: "get_download_url",
    description:
      "Generate a time-limited presigned download URL for an S3 asset. " +
      "Returns the URL as a string. Default TTL is 3600 seconds (1 hour).",
    schema: z.object({
      s3_key: z.string().describe("The S3 key returned by upload_asset"),
      ttl_seconds: z
        .number()
        .optional()
        .nullable()
        .describe("URL expiry in seconds (default 3600)"),
    }),
  },
);

// ── list_run_assets ───────────────────────────────────────────────────────────

export const listRunAssets = tool(
  async ({ run_id }) => {
    try {
      const rows = await getAssetsForRun(run_id);
      if (rows.length === 0) return `No assets found for run_id="${run_id}".`;
      return JSON.stringify(
        rows.map((r) => ({
          asset_id: r.id,
          s3_key: r.s3_key,
          filename: r.original_filename,
          asset_type: r.asset_type,
          mime_type: r.mime_type,
          created_at: r.created_at?.toISOString(),
        })),
      );
    } catch (err) {
      return `list_run_assets failed: ${(err as Error).message}`;
    }
  },
  {
    name: "list_run_assets",
    description:
      "List all asset records for a given run ID. " +
      "Returns a JSON array of { asset_id, s3_key, filename, asset_type, mime_type, created_at }.",
    schema: z.object({
      run_id: z.string().describe("LangGraph run ID to query assets for"),
    }),
  },
);

// ── download_asset ────────────────────────────────────────────────────────────

export const downloadAsset = tool(
  async ({ s3_key }) => {
    try {
      const buf = await downloadFile(s3_key);
      return buf.toString("base64");
    } catch (err) {
      if (err instanceof StorageError) {
        return `download_asset failed: ${err.message}`;
      }
      return `download_asset failed: ${(err as Error).message}`;
    }
  },
  {
    name: "download_asset",
    description:
      "Download an asset from S3 and return its content as a base64 string. " +
      "Use this only when the agent needs to read the file bytes directly. " +
      "For sharing with a user, prefer get_download_url instead.",
    schema: z.object({
      s3_key: z.string().describe("The S3 key of the asset to download"),
    }),
  },
);
