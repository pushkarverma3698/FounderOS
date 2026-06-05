/**
 * Unit tests for resolveSendableFile — the validation core behind send_file.
 *
 * send_file attaches a file from the founder's laptop into his Telegram chat.
 * It MUST reuse the path-guard so a prompt-injected "send me ~/.ssh/id_rsa"
 * can never exfiltrate a secret. These tests lock that boundary plus the
 * file-shape checks (exists, not a directory, not empty).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { resolveSendableFile } from "../../../src/tools/personal.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "founderos-send-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveSendableFile — allowed", () => {
  it("accepts a normal file and returns its name + size", async () => {
    const p = join(root, "report.txt");
    writeFileSync(p, "hello world");
    const r = await resolveSendableFile(p, root);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.name).toBe("report.txt");
      expect(r.size).toBe(11);
      expect(r.path).toBe(p);
    }
  });
});

describe("resolveSendableFile — security (secrets must never be sendable)", () => {
  it("rejects a *.pem file even though it exists", async () => {
    const p = join(root, "private.pem");
    writeFileSync(p, "-----BEGIN KEY-----");
    const r = await resolveSendableFile(p, root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toMatch(/secret|sensitive|denied|blocked/);
  });

  it("rejects a .env file", async () => {
    const p = join(root, ".env");
    writeFileSync(p, "TELEGRAM_BOT_TOKEN=123");
    const r = await resolveSendableFile(p, root);
    expect(r.ok).toBe(false);
  });

  it("rejects a file inside a .ssh directory", async () => {
    mkdirSync(join(root, ".ssh"));
    const p = join(root, ".ssh", "id_rsa");
    writeFileSync(p, "KEY");
    const r = await resolveSendableFile(p, root);
    expect(r.ok).toBe(false);
  });

  it("rejects a path that escapes the root via traversal", async () => {
    const r = await resolveSendableFile("../../etc/hosts", root);
    expect(r.ok).toBe(false);
  });
});

describe("resolveSendableFile — file shape", () => {
  it("rejects a directory", async () => {
    const d = join(root, "subdir");
    mkdirSync(d);
    const r = await resolveSendableFile(d, root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toMatch(/director/);
  });

  it("rejects a non-existent file", async () => {
    const r = await resolveSendableFile(join(root, "nope.txt"), root);
    expect(r.ok).toBe(false);
  });

  it("rejects an empty file (nothing to send)", async () => {
    const p = join(root, "empty.txt");
    writeFileSync(p, "");
    const r = await resolveSendableFile(p, root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.toLowerCase()).toMatch(/empty/);
  });
});
