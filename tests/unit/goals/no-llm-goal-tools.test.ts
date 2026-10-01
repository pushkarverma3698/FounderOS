/**
 * No model-callable path creates or edits a goal.
 *
 * The kernel does not know who is typing: a tool that is not approval-gated runs for a guest in an
 * allow-listed group. /goal and /goals are owner-only (OWNER_ONLY_COMMANDS), and that only means something
 * if the commands are the ONLY way to write a goal. So: no registered tool is a goal tool, and nothing the
 * model can reach (agents, tools, the kernel, the MCP surface) imports the goals code or storage. The
 * "Plan next step" button runs a kernel turn on a code-built prompt, but that turn gets the tools every
 * other turn gets and none of them can touch a goal.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { importsOf, resolveImport } from "../../../scripts/verify-architecture.js";
import { DEPARTMENT_TOOLS, SUPERVISOR_TOOLS } from "../../../src/agents/capabilities.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Everything a model can call, or that assembles what it can call. */
const MODEL_REACHABLE = ["src/agents", "src/tools", "src/kernel", "src/mcp"];

function tsFiles(dir: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) return tsFiles(rel);
    return rel.endsWith(".ts") && !rel.endsWith(".d.ts") ? [rel] : [];
  });
}

const files = MODEL_REACHABLE.flatMap(tsFiles);
const text = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));

/** Names imported by `import { a, b as c } from "<spec>"` statements in `source`, with their specifier. */
function namedImports(source: string): { spec: string; names: string[] }[] {
  return [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)].map((m) => ({
    spec: m[2] as string,
    names: (m[1] as string).split(",").map((n) => (n.trim().split(/\s+as\s+/)[0] ?? "").replace(/^type\s+/, "").trim()).filter(Boolean),
  }));
}

describe("the tool registry", () => {
  const names = [...Object.values(DEPARTMENT_TOOLS).flat(), ...SUPERVISOR_TOOLS].map((t) => String((t as { name?: unknown }).name));

  it("was actually read: it lists a substantial set of tools, including ones this test did not add", () => {
    expect(names.length).toBeGreaterThan(20);
    expect(names).toContain("dispatch_antigravity_task");
  });

  it("contains no tool that creates, edits or reads goals", () => {
    expect(names.filter((n) => /goal/i.test(n))).toEqual([]);
  });
});

describe("everything a model can reach", () => {
  it("covers a real body of code, so an empty scan cannot pass for a clean one", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("src/agents/capabilities.ts");
  });

  it("imports nothing from src/goals, the goals schema, or the goal gateway modules", () => {
    const offenders: string[] = [];
    for (const [file, source] of text) {
      for (const spec of importsOf(source)) {
        const resolved = resolveImport(file, spec);
        if (resolved !== null && (resolved.startsWith("src/goals/") || resolved === "src/db/goals-schema" || resolved.startsWith("src/gateway/goal-"))) {
          offenders.push(`${file} imports ${resolved}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not pull the goals tables out of the schema barrel either", () => {
    const offenders: string[] = [];
    for (const [file, source] of text) {
      for (const { spec, names } of namedImports(source)) {
        const resolved = resolveImport(file, spec);
        if (resolved === "src/db/schema" && names.some((n) => n === "goals" || n === "goalReviews")) offenders.push(`${file} imports the goals tables`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not write to the goals tables by name in raw SQL", () => {
    const offenders = [...text].filter(([, source]) => /\bagents\.goals\b|\bgoal_reviews\b/.test(source)).map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
