/**
 * FounderOS — S3 Asset Storage Client
 * =====================================
 * Thin wrapper around @aws-sdk/client-s3. All S3 errors are caught and
 * re-raised as StorageError so callers never see raw AWS SDK exceptions.
 *
 * Supports AWS S3, Cloudflare R2, and MinIO via STORAGE_ENDPOINT_URL.
 * Key format: "{prefix}/{run_id}/{uuid4}_{sanitized_filename}"
 *
 * Seam events are emitted by the TraceCallback (tool.call / tool.result)
 * when these functions are called via the LangGraph storage tools. At the
 * infra level, structured log entries serve the same observability purpose.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { childLogger } from "../logger.js";

const log = childLogger({ module: "infra:s3" });

// ── Custom error ──────────────────────────────────────────────────────────────

export class StorageError extends Error {
  constructor(
    message: string,
    public readonly s3Key: string,
  ) {
    super(`StorageError: ${message} [key=${s3Key}]`);
    this.name = "StorageError";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBucket(): string {
  const b = process.env["STORAGE_BUCKET"]?.trim();
  if (!b) throw new StorageError("STORAGE_BUCKET env var is not set", "(none)");
  return b;
}

/**
 * Normalize a filename for safe use as an S3 key segment:
 * lowercase, spaces to underscores, strip anything except a-z 0-9 . _
 */
export function sanitizeFilename(filename: string): string {
  return filename
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9._]/g, "");
}

function buildClient(): S3Client {
  const endpoint = process.env["STORAGE_ENDPOINT_URL"]?.trim() || undefined;
  return new S3Client({
    region: process.env["AWS_REGION"]?.trim() ?? "us-east-1",
    credentials: {
      accessKeyId: process.env["AWS_ACCESS_KEY_ID"] ?? "",
      secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"] ?? "",
    },
    ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
  });
}

// Lazy singleton — one client per process lifetime.
let _client: S3Client | undefined;

function getClient(): S3Client {
  if (!_client) _client = buildClient();
  return _client;
}

/** Replace the singleton — only for use in tests. */
export function _setClientForTest(client: S3Client): void {
  _client = client;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Upload bytes to S3 and return the key.
 * Key: "{prefix}/{run_id}/{uuid4}_{sanitized_filename}"
 */
export async function uploadFile(
  fileBytes: Buffer,
  filename: string,
  runId: string,
  prefix = "uploads",
): Promise<string> {
  const safe = sanitizeFilename(filename);
  const s3Key = `${prefix}/${runId}/${randomUUID()}_${safe}`;

  log.info({ s3Key, runId, prefix, bytes: fileBytes.length }, "storage.upload.start");

  try {
    await getClient().send(
      new PutObjectCommand({ Bucket: getBucket(), Key: s3Key, Body: fileBytes }),
    );
    log.info({ s3Key }, "storage.upload.ok");
    return s3Key;
  } catch (err) {
    log.error({ s3Key, err }, "storage.upload.error");
    throw new StorageError((err as Error).message, s3Key);
  }
}

/** Download an object from S3 and return its bytes. */
export async function downloadFile(s3Key: string): Promise<Buffer> {
  log.info({ s3Key }, "storage.download.start");

  try {
    const res = await getClient().send(
      new GetObjectCommand({ Bucket: getBucket(), Key: s3Key }),
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    const buf = Buffer.concat(chunks);
    log.info({ s3Key, bytes: buf.length }, "storage.download.ok");
    return buf;
  } catch (err) {
    log.error({ s3Key, err }, "storage.download.error");
    throw new StorageError((err as Error).message, s3Key);
  }
}

/**
 * Generate a time-limited presigned GET URL for a key.
 * Default TTL: 3600 seconds (1 hour).
 */
export async function generatePresignedUrl(
  s3Key: string,
  ttlSeconds = 3600,
): Promise<string> {
  log.info({ s3Key, ttlSeconds }, "storage.presign.start");

  try {
    const url = await getSignedUrl(
      getClient(),
      new GetObjectCommand({ Bucket: getBucket(), Key: s3Key }),
      { expiresIn: ttlSeconds },
    );
    log.info({ s3Key }, "storage.presign.ok");
    return url;
  } catch (err) {
    log.error({ s3Key, err }, "storage.presign.error");
    throw new StorageError((err as Error).message, s3Key);
  }
}

/** Permanently delete an object from S3. */
export async function deleteFile(s3Key: string): Promise<void> {
  log.info({ s3Key }, "storage.delete.start");

  try {
    await getClient().send(
      new DeleteObjectCommand({ Bucket: getBucket(), Key: s3Key }),
    );
    log.info({ s3Key }, "storage.delete.ok");
  } catch (err) {
    log.error({ s3Key, err }, "storage.delete.error");
    throw new StorageError((err as Error).message, s3Key);
  }
}
