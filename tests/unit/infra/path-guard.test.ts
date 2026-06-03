/**
 * Unit tests for the personal-department path guard.
 *
 * Why: the `personal` department gives a Telegram-driven LLM filesystem + shell
 * access. The agent ingests untrusted email/web text, so prompt injection is in
 * scope. This guard is a deterministic hard limit: every file path and shell cwd
 * must resolve inside the personal root ($HOME by default), and secret/system
 * paths are denied even for reads (they are the exfil targets).
 *
 * Pure functions → no mocks. RED until src/infra/path-guard.ts exists.
 */

import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { resolveSafePath, flagDangerousCommand } from "../../../src/infra/path-guard.js";

const HOME = os.homedir();

describe("resolveSafePath — allowed paths", () => {
  it("accepts a plain file under home and returns its absolute path", () => {
    const r = resolveSafePath("Projects/notes.md");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(path.join(HOME, "Projects/notes.md"));
  });

  it("expands a leading ~ to the home directory", () => {
    const r = resolveSafePath("~/Projects/app/index.ts");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(path.join(HOME, "Projects/app/index.ts"));
  });

  it("accepts an absolute path that is already inside home", () => {
    const abs = path.join(HOME, "Desktop/todo.txt");
    const r = resolveSafePath(abs);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(abs);
  });

  it("accepts the home root itself", () => {
    const r = resolveSafePath("~");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toBe(HOME);
  });
});

describe("resolveSafePath — escapes home", () => {
  it("rejects an absolute system path", () => {
    const r = resolveSafePath("/etc/passwd");
    expect(r.ok).toBe(false);
  });

  it("rejects traversal that climbs out of home", () => {
    const r = resolveSafePath("../../../../etc/passwd");
    expect(r.ok).toBe(false);
  });

  it("rejects a path that normalizes to outside home even with a home prefix", () => {
    const r = resolveSafePath("~/../../etc/hosts");
    expect(r.ok).toBe(false);
  });
});

describe("resolveSafePath — secret denylist (blocked even though inside home)", () => {
  const blocked = [
    ".ssh/id_rsa",
    ".aws/credentials",
    ".gnupg/secring.gpg",
    ".config/gh/hosts.yml",
    "Library/Keychains/login.keychain-db",
    "Projects/app/.env",
    "secret.pem",
    "backup/id_rsa.pub",
  ];
  for (const rel of blocked) {
    it(`denies ${rel}`, () => {
      const r = resolveSafePath(rel);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/secret|denied|sensitive/i);
    });
  }
});

describe("resolveSafePath — PERSONAL_ROOT override", () => {
  it("confines to PERSONAL_ROOT when set, rejecting sibling paths", () => {
    const root = path.join(HOME, "Projects/founderos-personal");
    const inside = resolveSafePath("notes/today.md", root);
    expect(inside.ok).toBe(true);
    if (inside.ok) expect(inside.path).toBe(path.join(root, "notes/today.md"));

    const outside = resolveSafePath("~/Desktop/other.txt", root);
    expect(outside.ok).toBe(false);
  });
});

describe("flagDangerousCommand", () => {
  it("flags rm -rf on a root-ish path", () => {
    expect(flagDangerousCommand("rm -rf /")).toBe(true);
    expect(flagDangerousCommand("sudo rm -rf ~/")).toBe(true);
  });

  it("flags disk-destroying and fork-bomb patterns", () => {
    expect(flagDangerousCommand("mkfs.ext4 /dev/disk2")).toBe(true);
    expect(flagDangerousCommand("dd if=/dev/zero of=/dev/disk0")).toBe(true);
    expect(flagDangerousCommand(":(){ :|:& };:")).toBe(true);
  });

  it("does not flag ordinary commands", () => {
    expect(flagDangerousCommand("ls -la ~/Projects")).toBe(false);
    expect(flagDangerousCommand("node scripts/build.js")).toBe(false);
    expect(flagDangerousCommand("git status")).toBe(false);
  });
});
