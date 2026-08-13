/**
 * Task 3 — the repo-root resolver, pinned against the prod defect it fixes.
 * ==========================================================================
 * Prod runs `node dist/src/index.js`, so the old root derivation landed on
 * `/opt/founderos/dist`: 0 source files collected and `dist/package.json`
 * missing, which threw ENOENT into a catch that logged "non-fatal" and sent the
 * founder nothing. The `dist` case below is that exact layout.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoRoot, repoRoot } from "../../../src/evolution/repo-root.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "repo-root-"));
  writeFileSync(join(root, "package.json"), "{}");
  mkdirSync(join(root, "src", "evolution"), { recursive: true });
  // The compiled layout: dist/ has src/ but NO package.json, so it is not a root.
  mkdirSync(join(root, "dist", "src", "evolution"), { recursive: true });
  mkdirSync(join(root, "dist", "scripts"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("findRepoRoot", () => {
  it("resolves the root from a source-tree directory", () => {
    expect(findRepoRoot(join(root, "src", "evolution"))).toBe(root);
  });

  it("walks PAST dist/ to the real root — the prod defect", () => {
    // dist/ contains src/ but no package.json, so it must not be mistaken for the root.
    expect(findRepoRoot(join(root, "dist", "src", "evolution"))).toBe(root);
    expect(findRepoRoot(join(root, "dist", "scripts"))).toBe(root);
  });

  it("resolves the root from the root itself", () => {
    expect(findRepoRoot(root)).toBe(root);
  });

  it("throws rather than returning a wrong-but-plausible path", () => {
    const orphan = mkdtempSync(join(tmpdir(), "no-root-"));
    mkdirSync(join(orphan, "nested"), { recursive: true });

    // A temp dir has no package.json anywhere up to /, so this must fail loudly.
    expect(() => findRepoRoot(join(orphan, "nested"))).toThrow(/Cannot locate repository root/);

    rmSync(orphan, { recursive: true, force: true });
  });
});

describe("repoRoot", () => {
  it("finds THIS repository, and the tree it returns really holds the sources", () => {
    const found = repoRoot();

    // The guarantee that matters: the returned root is one the audit can analyze.
    expect(existsSync(join(found, "package.json"))).toBe(true);
    expect(existsSync(join(found, "src", "evolution", "run-audit.ts"))).toBe(true);
  });
});
