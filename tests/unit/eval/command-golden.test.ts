/**
 * Command golden set: structure ($0) and the scoring rule that a command is its own outcome.
 * The behavioural run is `pnpm eval -- --commands` (paid, live planner).
 */
import { describe, it, expect } from "vitest";
import { COMMAND_GOLDEN_TASKS } from "../../../src/eval/command-golden.js";
import { GOLDEN_TASKS } from "../../../src/eval/golden-tasks.js";
import { plannableCommands } from "../../../src/gateway/command-catalog.js";
import { scoreRouting } from "../../../src/eval/scoring.js";
import type { GoldenTask } from "../../../src/eval/types.js";

describe("COMMAND_GOLDEN_TASKS", () => {
  const names = new Set(plannableCommands().map((c) => c.name));

  it("every expected command is one the planner is actually offered", () => {
    for (const t of COMMAND_GOLDEN_TASKS.filter((x) => x.expectedCommand)) {
      expect(names.has(t.expectedCommand!), `${t.id} → /${t.expectedCommand}`).toBe(true);
    }
  });

  it("ids are unique, kept out of the default set, and cover positives and negatives", () => {
    const ids = COMMAND_GOLDEN_TASKS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    const base = new Set(GOLDEN_TASKS.map((t) => t.id));
    for (const id of ids) expect(base.has(id)).toBe(false);
    expect(COMMAND_GOLDEN_TASKS.filter((t) => t.expectedCommand).length).toBeGreaterThanOrEqual(25);
    expect(COMMAND_GOLDEN_TASKS.filter((t) => !t.expectedCommand).length).toBeGreaterThanOrEqual(5);
  });
});

describe("scoreRouting with commands", () => {
  const wantWhere: GoldenTask = { id: "a", input: "x", expectedRoute: null, expectedCommand: "where" };
  const wantReply: GoldenTask = { id: "b", input: "x", expectedRoute: null };
  const wantPlan: GoldenTask = { id: "c", input: "x", expectedRoute: "research" };
  const obs = (command?: { name: string; args: string }, route: "research" | null = null) => ({
    route,
    tools: [],
    hadInterrupt: false,
    command: command ?? null,
    steps: route ? [{ worker: route, objective: "o" }] : [],
  });

  it("passes only the right command name", () => {
    expect(scoreRouting(wantWhere, obs({ name: "where", args: "oplify" }))).toBe(true);
    expect(scoreRouting(wantWhere, obs({ name: "tasks", args: "" }))).toBe(false);
    expect(scoreRouting(wantWhere, obs())).toBe(false);
    expect(scoreRouting(wantWhere, obs(undefined, "research"))).toBe(false);
  });

  it("a command where a reply or a plan was expected is a miss", () => {
    expect(scoreRouting(wantReply, obs({ name: "where", args: "" }))).toBe(false);
    expect(scoreRouting(wantPlan, obs({ name: "where", args: "" }))).toBe(false);
    expect(scoreRouting(wantReply, obs())).toBe(true);
    expect(scoreRouting(wantPlan, obs(undefined, "research"))).toBe(true);
  });
});
