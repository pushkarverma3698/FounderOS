import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  assertContextIsolation,
  CONTEXT_ISOLATION_OUTPUT_MODE,
} from "../../../src/agents/context-isolation.js";

describe("assertContextIsolation (CLAUDE rule #20)", () => {
  it("returns last_message unchanged", () => {
    expect(assertContextIsolation("last_message")).toBe("last_message");
    expect(CONTEXT_ISOLATION_OUTPUT_MODE).toBe("last_message");
  });

  it("throws loudly on full_history (the leak mode)", () => {
    expect(() => assertContextIsolation("full_history")).toThrow(/Context isolation violation/);
    expect(() => assertContextIsolation("full_history")).toThrow(/rule #20/);
  });

  it("throws on any other mode", () => {
    expect(() => assertContextIsolation("")).toThrow();
    expect(() => assertContextIsolation("everything")).toThrow();
  });
});

describe("structural guard: no full_history literal under src/agents", () => {
  const AGENTS_DIR = join(process.cwd(), "src", "agents");

  const tsFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...tsFiles(p));
      else if (entry.name.endsWith(".ts")) out.push(p);
    }
    return out;
  };

  it("never assigns outputMode: full_history (silent context-leak regression)", () => {
    const offenders = tsFiles(AGENTS_DIR).filter((f) =>
      /outputMode:\s*["']full_history["']/.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("every createSupervisor call routes outputMode through the guard", () => {
    const offenders: string[] = [];
    for (const f of tsFiles(AGENTS_DIR)) {
      const src = readFileSync(f, "utf8");
      if (!src.includes("createSupervisor(")) continue;
      // Each supervisor builder must reference the isolation guard.
      if (!src.includes("assertContextIsolation")) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
