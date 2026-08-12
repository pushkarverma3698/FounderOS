/**
 * Boot-time loader for synthesize_skill-authored tools (src/agents/skill-loader.ts).
 *
 * The defect this closes: `synthesize_skill` wrote + typechecked a TypeScript
 * module into src/tools/custom/ and then registered NOTHING — DEPARTMENT_TOOLS
 * never saw it, a process restart would not load it, and only a human
 * hand-editing capabilities.ts made it callable. This suite pins the loader
 * that fixes that, using fully injected fs/import seams — no file ever
 * touches real disk, no real `tsc`/dynamic import runs, so this file is fast
 * and deterministic (contrast tests/unit/tools/skill-synthesizer.test.ts,
 * which DOES exercise the real write+typecheck path).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../../src/infra/logger.js", () => ({
  childLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  loadSynthesizedSkills,
  applySkillSynthesisLoader,
  stripSynthesizedTools,
  transpileSkillSource,
  SYNTHESIZED_SKILLS_DEPARTMENT,
  type SkillLoaderDeps,
} from "../../../src/agents/skill-loader.js";
import { sanitizeSkillName } from "../../../src/tools/skill-synthesizer.js";

/** A well-formed synthesized module namespace — duck-types as KernelTool. */
function wellFormedModule(name: string) {
  return {
    [name]: {
      name,
      description: "a fixture tool",
      invoke: vi.fn(async () => "ok"),
    },
  };
}

function makeDeps(overrides: Partial<SkillLoaderDeps> = {}): SkillLoaderDeps {
  return {
    readdir: vi.fn(async () => []),
    readFile: vi.fn(async () => ""),
    writeCompiled: vi.fn(async () => undefined),
    importModule: vi.fn(async () => ({})),
    ...overrides,
  };
}

describe("skill-loader — SKILL_SYNTHESIS_ENABLED off is a complete no-op", () => {
  const original = process.env["SKILL_SYNTHESIS_ENABLED"];
  beforeEach(() => {
    delete process.env["SKILL_SYNTHESIS_ENABLED"];
  });
  afterEach(() => {
    if (original === undefined) delete process.env["SKILL_SYNTHESIS_ENABLED"];
    else process.env["SKILL_SYNTHESIS_ENABLED"] = original;
  });

  it("never calls readdir when the flag is unset (the default)", async () => {
    const deps = makeDeps();
    const outcome = await loadSynthesizedSkills(new Set(), deps);
    expect(deps.readdir).not.toHaveBeenCalled();
    expect(outcome).toEqual({ loaded: [], skippedCount: 0 });
  });

  it("never calls readdir when the flag is explicitly false", async () => {
    process.env["SKILL_SYNTHESIS_ENABLED"] = "false";
    const deps = makeDeps();
    await loadSynthesizedSkills(new Set(), deps);
    expect(deps.readdir).not.toHaveBeenCalled();
  });
});

describe("skill-loader — flag on", () => {
  const original = process.env["SKILL_SYNTHESIS_ENABLED"];
  beforeEach(() => {
    process.env["SKILL_SYNTHESIS_ENABLED"] = "true";
  });
  afterEach(() => {
    if (original === undefined) delete process.env["SKILL_SYNTHESIS_ENABLED"];
    else process.env["SKILL_SYNTHESIS_ENABLED"] = original;
  });

  it("loads and merges a well-formed synthesized module", async () => {
    const deps = makeDeps({
      readdir: vi.fn(async () => ["scrape_competitor_pricing.ts"]),
      importModule: vi.fn(async () => wellFormedModule("scrape_competitor_pricing")),
    });
    const outcome = await loadSynthesizedSkills(new Set(), deps);
    expect(outcome.loaded).toHaveLength(1);
    expect(outcome.loaded[0]?.name).toBe("scrape_competitor_pricing");
    expect(typeof outcome.loaded[0]?.tool.invoke).toBe("function");
    expect(outcome.skippedCount).toBe(0);
    expect(deps.writeCompiled).toHaveBeenCalledOnce();
  });

  it("degrades to zero tools (never throws) when the directory does not exist", async () => {
    const deps = makeDeps({
      readdir: vi.fn(async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
    });
    const outcome = await loadSynthesizedSkills(new Set(), deps);
    expect(outcome).toEqual({ loaded: [], skippedCount: 0 });
  });

  it("skips (does not crash) a module that throws on import", async () => {
    const deps = makeDeps({
      readdir: vi.fn(async () => ["explodes.ts"]),
      importModule: vi.fn(async () => {
        throw new Error("boom during import");
      }),
    });
    const outcome = await loadSynthesizedSkills(new Set(), deps);
    expect(outcome.loaded).toHaveLength(0);
    expect(outcome.skippedCount).toBe(1);
  });

  it("skips (does not crash) a module with no valid tool export", async () => {
    const deps = makeDeps({
      readdir: vi.fn(async () => ["not_a_tool.ts"]),
      importModule: vi.fn(async () => ({ someString: "hello", someNumber: 42 })),
    });
    const outcome = await loadSynthesizedSkills(new Set(), deps);
    expect(outcome.loaded).toHaveLength(0);
    expect(outcome.skippedCount).toBe(1);
  });

  it("skips a module whose invoke is not callable (half a KernelTool)", async () => {
    const deps = makeDeps({
      readdir: vi.fn(async () => ["half_shaped.ts"]),
      importModule: vi.fn(async () => ({ half_shaped: { name: "half_shaped", invoke: "not-a-function" } })),
    });
    const outcome = await loadSynthesizedSkills(new Set(), deps);
    expect(outcome.loaded).toHaveLength(0);
    expect(outcome.skippedCount).toBe(1);
  });

  it("rejects a synthesized name colliding with an existing tool — never merges, never shadows", async () => {
    const deps = makeDeps({
      readdir: vi.fn(async () => ["read_file.ts"]),
      importModule: vi.fn(async () => wellFormedModule("read_file")),
    });
    const builtIns = new Set(["read_file", "write_file"]);
    const outcome = await loadSynthesizedSkills(builtIns, deps);
    expect(outcome.loaded).toHaveLength(0);
    expect(outcome.skippedCount).toBe(1);
    // Collision is checked BEFORE any compile/import work is wasted on it.
    expect(deps.importModule).not.toHaveBeenCalled();
  });

  it("re-sanitizes the name from the filename at load time — does not trust the module's own claim", async () => {
    // Filename looks unsanitised (spaces, punctuation) — exactly what a
    // filesystem could contain if something upstream ever got looser.
    const rawFilename = "Weird Name!!.ts";
    const rawBase = rawFilename.slice(0, -3);
    const expectedName = sanitizeSkillName(rawBase);
    expect(expectedName).not.toBe(rawBase); // the fixture IS unsanitised

    const deps = makeDeps({
      readdir: vi.fn(async () => [rawFilename]),
      // The module internally claims a DIFFERENT, also-unsanitised name —
      // the loader must ignore this claim entirely.
      importModule: vi.fn(async () => ({
        default: { name: "Totally Different Claimed Name", invoke: vi.fn() },
      })),
    });
    const outcome = await loadSynthesizedSkills(new Set(), deps);
    expect(outcome.loaded).toHaveLength(1);
    expect(outcome.loaded[0]?.name).toBe(expectedName);
    expect(outcome.loaded[0]?.tool.name).toBe(expectedName);
  });

  it("one malformed file never blocks a well-formed sibling in the same scan", async () => {
    const deps = makeDeps({
      readdir: vi.fn(async () => ["explodes.ts", "good_tool.ts"]),
      importModule: vi.fn(async (fileUrl: string) => {
        if (fileUrl.includes("explodes")) throw new Error("boom");
        return wellFormedModule("good_tool");
      }),
    });
    const outcome = await loadSynthesizedSkills(new Set(), deps);
    expect(outcome.loaded).toHaveLength(1);
    expect(outcome.loaded[0]?.name).toBe("good_tool");
    expect(outcome.skippedCount).toBe(1);
  });
});

describe("applySkillSynthesisLoader — merge into DEPARTMENT_TOOLS-shaped target", () => {
  const original = process.env["SKILL_SYNTHESIS_ENABLED"];
  beforeEach(() => {
    process.env["SKILL_SYNTHESIS_ENABLED"] = "true";
  });
  afterEach(() => {
    if (original === undefined) delete process.env["SKILL_SYNTHESIS_ENABLED"];
    else process.env["SKILL_SYNTHESIS_ENABLED"] = original;
  });

  it("merges a validated tool into the synthesized-skills department, alongside built-ins", async () => {
    const target: Record<string, { name: string }[]> = {
      admin: [{ name: "read_context" }, { name: "record_event" }],
      research: [{ name: "search_web" }],
    };
    const deps = makeDeps({
      readdir: vi.fn(async () => ["scrape_competitor_pricing.ts"]),
      importModule: vi.fn(async () => wellFormedModule("scrape_competitor_pricing")),
    });
    const outcome = await applySkillSynthesisLoader(target, deps);
    expect(outcome.loaded).toHaveLength(1);
    const names = target[SYNTHESIZED_SKILLS_DEPARTMENT]!.map((t) => t.name);
    expect(names).toContain("scrape_competitor_pricing");
    expect(names).toContain("read_context"); // built-ins untouched
  });

  it("collision against a built-in in a DIFFERENT department is still rejected", async () => {
    const target: Record<string, { name: string }[]> = {
      admin: [{ name: "record_event" }],
      personal: [{ name: "run_shell" }],
    };
    const deps = makeDeps({
      readdir: vi.fn(async () => ["run_shell.ts"]),
      importModule: vi.fn(async () => wellFormedModule("run_shell")),
    });
    const outcome = await applySkillSynthesisLoader(target, deps);
    expect(outcome.loaded).toHaveLength(0);
    expect(outcome.skippedCount).toBe(1);
    expect(target["personal"]!.map((t) => t.name)).toEqual(["run_shell"]);
    expect(target[SYNTHESIZED_SKILLS_DEPARTMENT]?.some((t) => t.name === "run_shell")).toBeFalsy();
  });

  it("re-running (e.g. a /connect-triggered kernel rebuild) does not duplicate a previous merge", async () => {
    const target: Record<string, { name: string }[]> = { admin: [{ name: "record_event" }] };
    const deps = makeDeps({
      readdir: vi.fn(async () => ["my_tool.ts"]),
      importModule: vi.fn(async () => wellFormedModule("my_tool")),
    });
    await applySkillSynthesisLoader(target, deps);
    await applySkillSynthesisLoader(target, deps);
    const count = target[SYNTHESIZED_SKILLS_DEPARTMENT]!.filter((t) => t.name === "my_tool").length;
    expect(count).toBe(1);
  });

  it("stripSynthesizedTools removes only its own marked entries, never built-ins", () => {
    const marked = { name: "my_tool", invoke: vi.fn() };
    Object.defineProperty(marked, "__founderosSynthesized", { value: true, enumerable: false });
    const target: Record<string, { name: string }[]> = {
      admin: [{ name: "record_event" }, marked as unknown as { name: string }],
    };
    stripSynthesizedTools(target);
    expect(target["admin"]!.map((t) => t.name)).toEqual(["record_event"]);
  });
});

describe("transpileSkillSource", () => {
  it("strips TypeScript types into plain ESM the runtime can execute", () => {
    const out = transpileSkillSource(
      `export function add(a: number, b: number): number { return a + b; }`,
    );
    expect(out).not.toContain(": number");
    expect(out).toContain("function add(a, b)");
  });
});
