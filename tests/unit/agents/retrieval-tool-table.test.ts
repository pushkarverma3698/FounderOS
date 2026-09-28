/**
 * One reader per RAG table per worker — the mechanism behind "one tool per corpus".
 * ================================================================================
 * 2026-09-26, prod: asked about "FounderOS Pushkar", the research worker called
 * search_knowledge AND search_turicks_brain with the same query in one turn. Both
 * run runRagSearch("brain_memories", …): same engine, same table, same rows, two
 * tool calls. prompts/research.ts already told it not to. A prompt rule with no
 * mechanism behind it (CLAUDE.md #27) — this file is the mechanism.
 *
 * RETRIEVAL_TOOL_TABLE (src/agents/capabilities.ts) declares which RAG table each
 * retrieval tool reads. Three checks keep that declaration load-bearing:
 *   1. no worker holds two tools that read the same table;
 *   2. every worker tool defined in a module that imports the RAG engine has an
 *      entry — otherwise a new retrieval tool walks past check 1 unseen;
 *   3. every entry names the table the tool really queries (the engine is spied).
 *
 * Known limit of check 2: it sees tools whose OWN module imports the engine (or a
 * RAG tool module). A tool reaching runRagSearch through some new helper module
 * would need that module added to RAG_ENGINE_MODULES below.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The one retrieval path (src/db/rag-query.ts: "there is exactly one retrieval
// path"). Every RAG tool calls runRagSearch, so the table passed here IS the
// table the tool reads.
const engine = vi.hoisted(() => ({ tables: [] as string[] }));
vi.mock("../../../src/db/rag-query.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/db/rag-query.js")>()),
  runRagSearch: vi.fn(async (table: string) => {
    engine.tables.push(table);
    return { hits: [], mode: "hybrid" as const };
  }),
}));

const { DEPARTMENT_TOOLS, RETRIEVAL_TOOL_TABLE } = await import("../../../src/agents/capabilities.js");
const ragTools = await import("../../../src/tools/rag.js");

type NamedTool = { name: string };
type Registry = Record<string, NamedTool[]>;

/** "<worker>: <tool> + <tool> both read <table>" for every table a worker reads twice. */
function tablesReadTwice(registry: Registry, tableOf: Readonly<Record<string, string>>): string[] {
  const violations: string[] = [];
  for (const [worker, tools] of Object.entries(registry)) {
    const readers = new Map<string, string[]>();
    for (const { name } of tools) {
      const table = tableOf[name];
      if (table) readers.set(table, [...(readers.get(table) ?? []), name]);
    }
    for (const [table, names] of readers) {
      if (names.length > 1) violations.push(`${worker}: ${names.join(" + ")} both read ${table}`);
    }
  }
  return violations;
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function tsFilesUnder(rel: string): string[] {
  return readdirSync(join(ROOT, rel), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts"))
    .map((e) => join(e.parentPath, e.name));
}

/**
 * A value import (not `import type`) of the RAG engine, or of a module that
 * exports RAG tools. src/mcp is not scanned: its tools are never placed in
 * DEPARTMENT_TOOLS, and the brain MCP's own `search_memory` shares a name with
 * the kernel's episodic-memory tool.
 */
const RAG_ENGINE_MODULES =
  /^\s*import\s+(?!type\b)[^;]*?from\s+["'][./]+(?:db\/rag-query|db\/rag-search|db\/rag-hybrid|infra\/rag-orchestrator|tools\/rag|tools\/knowledge)\.js["']/m;

/** Tool names defined in any src/tools or src/agents module that reaches the RAG engine. */
function ragReachingToolNames(): Set<string> {
  const names = new Set<string>();
  for (const file of [...tsFilesUnder("src/tools"), ...tsFilesUnder("src/agents")]) {
    const source = readFileSync(file, "utf8");
    if (!RAG_ENGINE_MODULES.test(source)) continue;
    for (const m of source.matchAll(/\bname:\s*["']([a-z][a-z0-9_]*)["']/g)) names.add(m[1]!);
  }
  return names;
}

type Invokable = NamedTool & {
  invoke?: (args: Record<string, unknown>) => Promise<unknown>;
  execute?: (args: Record<string, unknown>) => Promise<unknown>;
};

/** The object a worker would call — the bound tool when one exists, else the UnifiedTool scripts use. */
function findTool(name: string): Invokable | undefined {
  const bound = (Object.values(DEPARTMENT_TOOLS).flat() as Invokable[]).find((t) => t.name === name);
  if (bound) return bound;
  return (Object.values(ragTools) as Invokable[]).find((t) => t?.name === name);
}

describe("RETRIEVAL_TOOL_TABLE — one reader per RAG table per worker", () => {
  it("no worker holds two tools that read the same RAG table", () => {
    expect(tablesReadTwice(DEPARTMENT_TOOLS as Registry, RETRIEVAL_TOOL_TABLE)).toEqual([]);
  });

  it("the check flags a worker holding two readers of one table (the 2026-09-26 research list)", () => {
    // Guards the guard: a checker that always returns [] would pass the test above.
    const research = [{ name: "search_web" }, { name: "search_knowledge" }, { name: "search_turicks_brain" }];
    expect(tablesReadTwice({ research }, RETRIEVAL_TOOL_TABLE)).toEqual([
      "research: search_knowledge + search_turicks_brain both read brain_memories",
    ]);
  });

  it("every worker tool that reaches the RAG engine declares its table", () => {
    const reaching = ragReachingToolNames();
    // Sanity: the scan must see the known readers, or it is scanning nothing.
    expect([...reaching]).toEqual(expect.arrayContaining(["search_knowledge", "search_research_cache"]));

    const held = Object.entries(DEPARTMENT_TOOLS).flatMap(([worker, tools]) =>
      (tools as NamedTool[]).map((t) => ({ worker, name: t.name })),
    );
    const undeclared = held
      .filter(({ name }) => reaching.has(name) && !(name in RETRIEVAL_TOOL_TABLE))
      .map(({ worker, name }) => `${worker}/${name}`);
    expect(undeclared, "add these to RETRIEVAL_TOOL_TABLE (src/agents/capabilities.ts)").toEqual([]);
  });

  it.each(Object.entries(RETRIEVAL_TOOL_TABLE))("%s queries %s, the table it declares", async (name, table) => {
    const tool = findTool(name);
    expect(tool, `${name} is declared but no such tool exists`).toBeDefined();

    engine.tables.length = 0;
    const args = { query: "retrieval probe" };
    if (tool!.invoke) await tool!.invoke(args);
    else await tool!.execute!(args);

    expect([...new Set(engine.tables)]).toEqual([table]);
  });
});
