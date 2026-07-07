/**
 * REGRESSION — Bug #8 (H5): path-guard must resolve symlinks before deciding
 * containment/denylist, not just the lexical path.
 * ============================================================================
 * History: `resolveSafePath` checked `path.resolve()` output directly. A
 * symlink created INSIDE the personal root by an earlier approved write (e.g.
 * `ln -s ~/.ssh ~/Documents/backup`) resolved lexically inside the root and
 * passed every check, while `read_file`/`write_file` would actually operate on
 * whatever the symlink pointed at — outside the root, or a denylisted secret
 * directory. The guard's own header claims it is a "HARD gate that does NOT
 * depend on the LLM behaving" — that was only true as long as no symlink
 * existed anywhere under the root.
 *
 * APPEND-ONLY. Never delete or weaken to make CI green. If a case here goes
 * red, the path-guard regressed — fix the guard, not the test.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { resolveSafePath } from "../../src/infra/path-guard.js";

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

describe("REGRESSION bug#8 — symlink escape is denied", () => {
  it("denies a symlink inside the root that points OUTSIDE the root", () => {
    const root = mkdtempSync(join(homedir(), ".founderos-pathguard-root-"));
    cleanupDirs.push(root);
    const outside = mkdtempSync(join(tmpdir(), "founderos-pathguard-outside-"));
    cleanupDirs.push(outside);
    writeFileSync(join(outside, "loot.txt"), "outside the root");
    symlinkSync(outside, join(root, "escape-link"));

    const r = resolveSafePath("escape-link/loot.txt", root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/outside the personal root/i);
  });

  it("denies a symlink inside the root whose REAL target is a denylisted secret directory", () => {
    // The symlink target lives INSIDE the same root (containment passes) so
    // this isolates the secret-on-realpath check from the outside-root check
    // already covered by the previous test.
    const root = mkdtempSync(join(homedir(), ".founderos-pathguard-root2-"));
    cleanupDirs.push(root);
    const realSsh = join(root, "real-ssh-storage", ".ssh");
    mkdirSync(realSsh, { recursive: true });
    writeFileSync(join(realSsh, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----");
    symlinkSync(realSsh, join(root, "innocuous-name"));

    const r = resolveSafePath("innocuous-name/id_rsa", root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/secret|sensitive/i);
  });

  it("still allows an ordinary file with no symlinks in its path", () => {
    const root = mkdtempSync(join(homedir(), ".founderos-pathguard-root3-"));
    cleanupDirs.push(root);
    writeFileSync(join(root, "notes.md"), "hello");

    const r = resolveSafePath("notes.md", root);
    expect(r.ok).toBe(true);
  });
});
