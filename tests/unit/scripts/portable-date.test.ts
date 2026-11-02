/**
 * Every `date -d` in the shell scripts carries a BSD fallback on the same line.
 * ==============================================================================
 * `date -d` is GNU-only. On macOS it fails, so a helper that parses a date with it silently takes its
 * error branch there (pr-brain said every token "has no creation date"; the quiet-hours digest printed
 * every time as 00:00). Linux CI cannot see that, so this check reads the source instead:
 * a `date -d` line must also hold `date -j -f` (parse a string) or `date -r` (format an epoch).
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const ROOTS = ["deploy", "scripts"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules") return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("GNU date -d has a BSD fallback (macOS)", () => {
  it("no line in deploy/ or scripts/ uses date -d without date -j -f or date -r beside it", () => {
    const offenders: string[] = [];
    for (const file of ROOTS.flatMap((r) => files(join(REPO, r)))) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (line.trimStart().startsWith("#")) return;
          if (!/\bdate\b[^|;]*\s-d\s/.test(line)) return;
          if (/\bdate\b[^|;]*\s-j\s+-f\s|\bdate\b[^|;]*\s-r\s/.test(line)) return;
          offenders.push(`${relative(REPO, file)}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
