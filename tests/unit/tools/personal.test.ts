/**
 * Unit tests for the personal-department raw tool implementations.
 *
 * These exercise REAL filesystem + shell behaviour (no mocks) inside a throwaway
 * directory under $HOME, passed as an explicit root so the path-guard confines to
 * it. Browser actions are tested at the pure script-builder level (no Safari).
 *
 * RED until src/tools/personal.ts exists.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readFileSafe,
  listDirSafe,
  writeFileSafe,
  runShellSafe,
  buildBrowserScript,
} from "../../../src/tools/personal.js";

let ROOT: string;

beforeAll(async () => {
  ROOT = path.join(os.homedir(), `.founderos-personal-test-${Date.now()}`);
  await fs.mkdir(path.join(ROOT, "sub"), { recursive: true });
  await fs.writeFile(path.join(ROOT, "hello.txt"), "hi there", "utf8");
});

afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe("readFileSafe", () => {
  it("reads a file inside the root", async () => {
    const r = await readFileSafe("hello.txt", ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("hi there");
  });

  it("refuses a path outside the root", async () => {
    const r = await readFileSafe("/etc/hosts", ROOT);
    expect(r.ok).toBe(false);
  });

  it("refuses a secret path even inside home", async () => {
    const r = await readFileSafe("~/.ssh/id_rsa");
    expect(r.ok).toBe(false);
  });

  // ── Stabilization fix #1: symlink bypass ─────────────────────────────────
  // A symlink inside ROOT that points to a secret path must be denied.
  // Before the fix: resolveSafePath was lexical — ROOT/evil → ~/.ssh passes.
  // After the fix: realpath resolves the symlink, re-checked against denylist.
  it("refuses a symlink inside root that resolves to a secret path", async () => {
    const symlinkPath = path.join(ROOT, "evil-link");
    await fs.symlink(path.join(os.homedir(), ".ssh"), symlinkPath).catch(() => {/* already exists */});
    const r = await readFileSafe("evil-link", ROOT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/denied|secret|sensitive/i);
  });

  it("refuses a symlink inside root that resolves to a path outside home", async () => {
    const symlinkPath = path.join(ROOT, "etc-link");
    await fs.symlink("/etc", symlinkPath).catch(() => {/* already exists */});
    const r = await readFileSafe("etc-link", ROOT);
    expect(r.ok).toBe(false);
  });

  // ── Stabilization fix #2: OOM protection (regression spec) ───────────────
  // readFileSafe must not buffer more than MAX_OUTPUT chars. Output is capped at
  // 100 000 chars even for files many times larger.
  it("caps returned content at 100 000 chars for oversized files", async () => {
    const bigContent = "A".repeat(150_000);
    await fs.writeFile(path.join(ROOT, "big.txt"), bigContent, "utf8");
    const r = await readFileSafe("big.txt", ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content.length).toBeLessThanOrEqual(100_000);
      expect(r.content.length).toBeGreaterThan(0);
    }
  });
});

describe("listDirSafe", () => {
  it("lists entries in a directory inside the root", async () => {
    const r = await listDirSafe(".", ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entries).toContain("hello.txt");
      expect(r.entries).toContain("sub");
    }
  });

  it("refuses a symlink dir inside root that resolves outside home", async () => {
    const symlinkPath = path.join(ROOT, "etc-dir-link");
    await fs.symlink("/etc", symlinkPath).catch(() => {});
    const r = await listDirSafe("etc-dir-link", ROOT);
    expect(r.ok).toBe(false);
  });
});

describe("writeFileSafe", () => {
  it("writes a file inside the root and it can be read back", async () => {
    const r = await writeFileSafe("sub/out.txt", "written", ROOT);
    expect(r.ok).toBe(true);
    const back = await fs.readFile(path.join(ROOT, "sub/out.txt"), "utf8");
    expect(back).toBe("written");
  });

  it("creates parent directories as needed", async () => {
    const r = await writeFileSafe("deep/nested/file.txt", "x", ROOT);
    expect(r.ok).toBe(true);
  });

  it("refuses to write outside the root", async () => {
    const r = await writeFileSafe("../escape.txt", "x", ROOT);
    expect(r.ok).toBe(false);
  });
});

describe("runShellSafe", () => {
  it("runs a command in the root and captures stdout", async () => {
    const r = await runShellSafe("echo hello-shell", ".", ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stdout.trim()).toBe("hello-shell");
  });

  it("refuses a cwd outside the root", async () => {
    const r = await runShellSafe("ls", "/etc", ROOT);
    expect(r.ok).toBe(false);
  });

  it("returns ok:false (not a throw) on a failing command", async () => {
    const r = await runShellSafe("exit 3", ".", ROOT);
    expect(r.ok).toBe(false);
  });
});

describe("buildBrowserScript", () => {
  it("opens a URL in Safari via AppleScript", () => {
    const s = buildBrowserScript("open_url", { url: "https://example.com" });
    expect(s).toContain("Safari");
    expect(s).toContain("https://example.com");
  });

  it("builds a get_page_text script", () => {
    const s = buildBrowserScript("get_page_text", {});
    expect(s).toContain("Safari");
    expect(s.toLowerCase()).toContain("text");
  });

  it("embeds JS for run_js", () => {
    const s = buildBrowserScript("run_js", { js: "document.title" });
    expect(s).toContain("document.title");
    expect(s).toContain("do JavaScript");
  });
});
