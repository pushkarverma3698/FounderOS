/**
 * Unit tests for the S3 storage layer.
 *
 * Tests: sanitizeFilename, uploadFile, downloadFile, generatePresignedUrl,
 *        deleteFile, and StorageError — all without a live S3 bucket.
 *
 * S3 calls are intercepted by injecting a mock S3Client via _setClientForTest.
 * No live AWS credentials are required.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Readable } from "node:stream";
import {
  sanitizeFilename,
  uploadFile,
  downloadFile,
  generatePresignedUrl,
  deleteFile,
  StorageError,
  _setClientForTest,
  listFiles,
  stageFile,
} from "../../../src/infra/storage/s3-client.js";

// ── Shared mock S3 client factory ─────────────────────────────────────────────

function makeMockClient(overrides: Record<string, unknown> = {}) {
  return {
    send: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as unknown as import("@aws-sdk/client-s3").S3Client;
}

// ── sanitizeFilename ──────────────────────────────────────────────────────────

describe("sanitizeFilename", () => {
  it("lowercases the filename", () => {
    expect(sanitizeFilename("Report.PDF")).toBe("report.pdf");
  });

  it("replaces spaces with underscores", () => {
    expect(sanitizeFilename("my file.txt")).toBe("my_file.txt");
  });

  it("strips non-alphanumeric except dots and underscores", () => {
    expect(sanitizeFilename("résumé (final)!.pdf")).toBe("rsum_final.pdf");
  });

  it("preserves existing underscores and dots", () => {
    expect(sanitizeFilename("my_report.v2.pdf")).toBe("my_report.v2.pdf");
  });

  it("handles empty string", () => {
    expect(sanitizeFilename("")).toBe("");
  });

  it("collapses multiple consecutive spaces into a single underscore", () => {
    expect(sanitizeFilename("a  b")).toBe("a_b");
  });
});

// ── StorageError ──────────────────────────────────────────────────────────────

describe("StorageError", () => {
  it("is an instance of Error", () => {
    const err = new StorageError("bucket not found", "uploads/x/file.pdf");
    expect(err).toBeInstanceOf(Error);
  });

  it("sets name to StorageError", () => {
    const err = new StorageError("msg", "key");
    expect(err.name).toBe("StorageError");
  });

  it("exposes the s3Key", () => {
    const err = new StorageError("msg", "uploads/run1/uuid_file.pdf");
    expect(err.s3Key).toBe("uploads/run1/uuid_file.pdf");
  });

  it("message includes the original message and key", () => {
    const err = new StorageError("NoSuchKey", "uploads/run1/file.pdf");
    expect(err.message).toContain("NoSuchKey");
    expect(err.message).toContain("uploads/run1/file.pdf");
  });
});

// ── uploadFile ────────────────────────────────────────────────────────────────

describe("uploadFile", () => {
  beforeEach(() => {
    process.env["STORAGE_BUCKET"] = "test-bucket";
  });

  it("returns a key matching the expected format", async () => {
    const mock = makeMockClient();
    _setClientForTest(mock);

    const key = await uploadFile(Buffer.from("hello"), "Report.PDF", "run-123");

    expect(key).toMatch(/^uploads\/run-123\/[a-f0-9-]+_report\.pdf$/);
  });

  it("uses custom prefix when provided", async () => {
    const mock = makeMockClient();
    _setClientForTest(mock);

    const key = await uploadFile(Buffer.from("data"), "file.txt", "run-abc", "outputs");
    expect(key).toMatch(/^outputs\/run-abc\//);
  });

  it("calls S3 send exactly once", async () => {
    const mock = makeMockClient();
    _setClientForTest(mock);

    await uploadFile(Buffer.from("x"), "f.txt", "r1");
    expect(mock.send).toHaveBeenCalledTimes(1);
  });

  it("throws StorageError when S3 send rejects", async () => {
    const mock = makeMockClient({
      send: vi.fn().mockRejectedValue(new Error("AccessDenied")),
    });
    _setClientForTest(mock);

    await expect(uploadFile(Buffer.from("x"), "f.txt", "r1")).rejects.toThrow(StorageError);
  });

  it("throws StorageError when STORAGE_BUCKET is not set", async () => {
    delete process.env["STORAGE_BUCKET"];
    const mock = makeMockClient();
    _setClientForTest(mock);

    await expect(uploadFile(Buffer.from("x"), "f.txt", "r1")).rejects.toThrow(StorageError);
  });

  it("sanitizes the filename inside the returned key", async () => {
    const mock = makeMockClient();
    _setClientForTest(mock);

    process.env["STORAGE_BUCKET"] = "test-bucket";
    const key = await uploadFile(Buffer.from("x"), "My Report (2).PDF", "run-xyz");
    // "My Report (2).PDF" → lowercase → "my report (2).pdf"
    //   → spaces to underscores → "my_report_(2).pdf"
    //   → strip non-[a-z0-9._] → "my_report_2.pdf"
    expect(key).toContain("my_report_2.pdf");
  });
});

// ── downloadFile ──────────────────────────────────────────────────────────────

describe("downloadFile", () => {
  beforeEach(() => {
    process.env["STORAGE_BUCKET"] = "test-bucket";
  });

  it("returns the file bytes as a Buffer", async () => {
    const expected = Buffer.from("file content");
    const readable = Readable.from([expected]);
    const mock = makeMockClient({
      send: vi.fn().mockResolvedValue({ Body: readable }),
    });
    _setClientForTest(mock);

    const result = await downloadFile("uploads/run1/uuid_file.txt");
    expect(result).toEqual(expected);
  });

  it("throws StorageError on S3 error", async () => {
    const mock = makeMockClient({
      send: vi.fn().mockRejectedValue(new Error("NoSuchKey")),
    });
    _setClientForTest(mock);

    await expect(downloadFile("bad/key")).rejects.toThrow(StorageError);
  });
});

// ── generatePresignedUrl ──────────────────────────────────────────────────────

describe("generatePresignedUrl", () => {
  beforeEach(() => {
    process.env["STORAGE_BUCKET"] = "test-bucket";
    process.env["AWS_ACCESS_KEY_ID"] = "test-key";
    process.env["AWS_SECRET_ACCESS_KEY"] = "test-secret";
    process.env["AWS_REGION"] = "us-east-1";
  });

  it("returns a non-empty string URL", async () => {
    // Use a real lightweight S3Client pointed at us-east-1 for presign (no network call)
    const { S3Client } = await import("@aws-sdk/client-s3");
    const realClient = new S3Client({
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    _setClientForTest(realClient);

    const url = await generatePresignedUrl("uploads/run1/uuid_file.pdf", 600);
    expect(typeof url).toBe("string");
    expect(url.length).toBeGreaterThan(0);
    expect(url).toContain("X-Amz-Signature");
  });

  it("throws StorageError when presigning fails", async () => {
    const mock = {
      send: vi.fn().mockRejectedValue(new Error("CredentialsError")),
    } as unknown as import("@aws-sdk/client-s3").S3Client;
    _setClientForTest(mock);

    await expect(generatePresignedUrl("key")).rejects.toThrow(StorageError);
  });
});

// ── deleteFile ────────────────────────────────────────────────────────────────

describe("deleteFile", () => {
  beforeEach(() => {
    process.env["STORAGE_BUCKET"] = "test-bucket";
  });

  it("calls S3 send once without throwing", async () => {
    const mock = makeMockClient();
    _setClientForTest(mock);

    await expect(deleteFile("uploads/run1/file.pdf")).resolves.toBeUndefined();
    expect(mock.send).toHaveBeenCalledTimes(1);
  });

  it("throws StorageError on S3 error", async () => {
    const mock = makeMockClient({
      send: vi.fn().mockRejectedValue(new Error("AccessDenied")),
    });
    _setClientForTest(mock);

    await expect(deleteFile("uploads/run1/file.pdf")).rejects.toThrow(StorageError);
  });
});

// ── listFiles ─────────────────────────────────────────────────────────────────

describe("listFiles", () => {
  beforeEach(() => {
    process.env["STORAGE_BUCKET"] = "test-bucket";
  });

  it("lists matching keys from S3 ListObjectsV2 response", async () => {
    const mock = makeMockClient({
      send: vi.fn().mockResolvedValue({
        Contents: [{ Key: "agent-runs/run1/outputs/out1.png" }, { Key: "agent-runs/run1/outputs/out2.png" }],
      }),
    });
    _setClientForTest(mock);

    const keys = await listFiles("agent-runs/run1/outputs/");
    expect(keys).toEqual(["agent-runs/run1/outputs/out1.png", "agent-runs/run1/outputs/out2.png"]);
    expect(mock.send).toHaveBeenCalledTimes(1);
  });

  it("throws StorageError on S3 list error", async () => {
    const mock = makeMockClient({
      send: vi.fn().mockRejectedValue(new Error("ListError")),
    });
    _setClientForTest(mock);

    await expect(listFiles("prefix")).rejects.toThrow(StorageError);
  });
});

// ── stageFile ─────────────────────────────────────────────────────────────────

describe("stageFile", () => {
  beforeEach(() => {
    process.env["STORAGE_BUCKET"] = "test-bucket";
  });

  it("stages a file preserving literal filename", async () => {
    const mock = makeMockClient();
    _setClientForTest(mock);

    const key = await stageFile(Buffer.from("brief content"), "BRIEF.md", "run-123");
    expect(key).toBe("agent-runs/run-123/brief.md");
    expect(mock.send).toHaveBeenCalledTimes(1);
  });

  it("throws StorageError on staging error", async () => {
    const mock = makeMockClient({
      send: vi.fn().mockRejectedValue(new Error("StageError")),
    });
    _setClientForTest(mock);

    await expect(stageFile(Buffer.from("x"), "f.txt", "r1")).rejects.toThrow(StorageError);
  });
});
