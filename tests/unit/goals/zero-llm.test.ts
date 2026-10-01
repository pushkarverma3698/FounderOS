/**
 * The standup is ZERO LLM by construction, not by intention.
 *
 * standup.test.ts proves it at runtime with an injected model that throws. This proves it structurally: the
 * whole import closure of src/goals (static and lazy imports, transitively) never reaches a model factory,
 * the kernel, the gateway or the budget guard. Two consequences the plan names follow from the same fact:
 * the standup makes no paid call, and it still goes out when the daily budget is spent, because nothing in
 * its path consults the budget. Only the "Plan next step" button (src/gateway/goal-commands.ts, outside this
 * closure) can start a kernel turn.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { importsOf, resolveImport } from "../../../scripts/verify-architecture.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Where a model, the kernel, the gateway or the spend guard live: the standup may reach none of them. */
const FORBIDDEN_PATHS = ["src/agents/", "src/kernel/", "src/gateway/", "src/infra/budget", "src/infra/daily-budget", "src/mcp/", "src/eval/"];
/** Packages that ARE an LLM client. */
const FORBIDDEN_PACKAGE = /^(?:@langchain\/|langchain$|openai$|@anthropic-ai\/|@google\/genai$|@google\/generative-ai$)/;

const LAZY_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function specifiersOf(text: string): string[] {
  return [...importsOf(text), ...[...text.matchAll(LAZY_IMPORT)].map((m) => m[1] as string)];
}

function fileFor(moduleId: string): string | null {
  for (const candidate of [`${moduleId}.ts`, `${moduleId}/index.ts`]) if (existsSync(`${ROOT}${candidate}`)) return candidate;
  return null;
}

/** Every repo file reachable from `roots`, and every package they import along the way. */
function closure(roots: readonly string[]): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const rel = queue.pop() as string;
    if (files.has(rel)) continue;
    files.add(rel);
    for (const spec of specifiersOf(readFileSync(`${ROOT}${rel}`, "utf8"))) {
      const resolved = resolveImport(rel, spec);
      if (resolved === null) {
        packages.add(spec);
        continue;
      }
      const next = fileFor(resolved);
      if (next !== null) queue.push(next);
    }
  }
  return { files, packages };
}

const goalFiles = readdirSync(`${ROOT}src/goals`).filter((f) => f.endsWith(".ts")).map((f) => `src/goals/${f}`);
const { files, packages } = closure([...goalFiles, "scripts/goals-standup.ts"]);

describe("the standup's import closure", () => {
  it("covers the goals modules and the CLI, so an empty scan cannot pass for a clean one", () => {
    expect(goalFiles.length).toBeGreaterThan(10);
    for (const expected of ["src/goals/standup.ts", "src/goals/standup-deps.ts", "src/goals/metric-deps.ts", "scripts/goals-standup.ts"]) {
      expect(files.has(expected), expected).toBe(true);
    }
    expect(files.size).toBeGreaterThan(goalFiles.length);
  });

  it("never reaches a model factory, the kernel, the gateway, MCP or the budget guard", () => {
    const reached = [...files].filter((f) => FORBIDDEN_PATHS.some((p) => f.startsWith(p)));
    expect(reached).toEqual([]);
  });

  it("never imports an LLM client package", () => {
    expect([...packages].filter((p) => FORBIDDEN_PACKAGE.test(p))).toEqual([]);
  });

  it("does reach the pieces it should: Postgres, Telegram's api-only sender and the halt flag", () => {
    for (const expected of ["src/db/client.ts", "src/infra/telegram-send.ts", "src/infra/halt.ts"]) {
      expect(files.has(expected), expected).toBe(true);
    }
    expect(packages.has("node-cron")).toBe(true);
  });
});
