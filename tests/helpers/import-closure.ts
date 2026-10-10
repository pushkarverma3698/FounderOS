/**
 * Every repo file a TypeScript entry reaches through relative imports (static,
 * `import type`, re-exports and dynamic `import("…")`). Used to pin what the
 * standalone jobs process may pull in.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;

function resolveTs(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base.replace(/\.js$/, ".ts"), `${base}.ts`, join(base, "index.ts"), base];
  return candidates.find((c) => c.endsWith(".ts") && existsSync(c)) ?? null;
}

export function importClosure(root: string, entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = entries.map((e) => resolve(root, e));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(IMPORT_RE)) {
      const next = resolveTs(file, match[1]!);
      if (next && !seen.has(next)) queue.push(next);
    }
  }
  return [...seen].map((f) => relative(root, f)).sort();
}
