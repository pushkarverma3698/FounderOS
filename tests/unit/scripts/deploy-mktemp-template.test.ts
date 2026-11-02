/**
 * Every mktemp template under deploy/ ends in its X's.
 * ====================================================
 * GNU mktemp (the VPS, CI) randomises `XXXXXX` even with a suffix after it. BSD mktemp (macOS) only randomises
 * TRAILING X's: `mktemp /tmp/agy-run-XXXXXX.jsonl` creates the literal file /tmp/agy-run-XXXXXX.jsonl. Two runs at
 * once then share one path, and the second fails with "mkstemp failed: File exists". That is how `pnpm gate` lost
 * ~112 agent-dispatch / pr-brain tests on the founder's Mac while CI stayed green: concurrent sandboxes collided on
 * the literal file, the losing tick got an empty path, and its fake agy never ran.
 *
 * A static check, so it fails on Linux too: the bug is invisible there at run time.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEPLOY = join(ROOT, "deploy");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** `file:line  template` for every mktemp template whose X's are followed by something else. */
function suffixedTemplates(path: string, text: string): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/\bmktemp\b([^)|;&]*)/g)) {
      for (const raw of (m[1] ?? "").trim().split(/\s+/)) {
        const t = raw.replace(/["']/g, "");
        if (/X{3,}/.test(t) && !/X{3,}$/.test(t)) out.push(`${relative(ROOT, path)}:${i + 1}  ${t}`);
      }
    }
  });
  return out;
}

describe("mktemp templates under deploy/", () => {
  it("the detector flags a suffix after the X's and passes trailing X's", () => {
    expect(suffixedTemplates("x", 'raw="$(mktemp /tmp/agy-run-XXXXXX.jsonl)"')).toHaveLength(1);
    expect(suffixedTemplates("x", 'raw="$(mktemp /tmp/claude-run-XXXXXX)"')).toEqual([]);
    expect(suffixedTemplates("x", 'tmp="$(mktemp -d /tmp/pass-p-XXXXXX)" || return 0')).toEqual([]);
  });

  it("no template has a suffix after its X's (BSD mktemp would not randomise it)", () => {
    const bad = files(DEPLOY).flatMap((p) => suffixedTemplates(p, readFileSync(p, "utf8")));
    expect(bad).toEqual([]);
  });
});
