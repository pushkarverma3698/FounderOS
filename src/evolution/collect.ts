/**
 * M0a — Evolution Engine v0: source collection (the ONLY I/O in the sensor).
 * ===========================================================================
 * Analyzers are pure functions over `SourceFile[]`; this module is the single
 * place that touches the filesystem. Keeping the split strict is what lets the
 * whole self-audit run in CI at $0 with reproducible numbers.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { SourceFile } from "./types.js";

/** Trees excluded from every rule (founder decision 2026-07-07) — mirrors verify-architecture.ts. */
const FROZEN_PREFIXES = ["apps/", "client/", "Github/"] as const;

const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", "dist"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(entry) || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Read every non-frozen TypeScript file under `srcDir`, paths relative to `root`. */
export function collectSourceFiles(root: string, srcDir = "src"): SourceFile[] {
  return walk(join(root, srcDir))
    .map((abs) => relative(root, abs))
    .filter((path) => !FROZEN_PREFIXES.some((p) => path.startsWith(p)))
    .map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
}

/** Production dependency names from package.json (devDependencies are not shipped). */
export function collectDependencies(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return Object.keys(pkg.dependencies ?? {});
}
