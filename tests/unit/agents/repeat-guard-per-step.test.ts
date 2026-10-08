/**
 * AG-046: repeat guards count identical calls inside ONE step, not across a
 * Telegram thread. Live 2026-10-07: the founder asked the same question at 21:34,
 * 21:35 and 21:36; the thread-wide 90s window blocked a later turn with "the result
 * is in the conversation above", which was false (each worker has an isolated context).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const execute = vi.fn();
vi.mock("../../../src/tools/github.js", () => ({
  githubTool: { execute: (...a: unknown[]) => execute(...a), description: "gh" },
}));
const readLogsExecute = vi.fn();
vi.mock("../../../src/tools/read-logs.js", () => ({
  readLogsTool: { execute: (...a: unknown[]) => readLogsExecute(...a), description: "read_logs" },
}));

const { githubRead } = await import("../../../src/agents/agent-tools/engineering.js");
const { readLogs } = await import("../../../src/agents/agent-tools/diagnostics.js");

const BLOCKED = /already called/i;
const ARGS = { action: "list_prs", owner: "o", repo: "r" } as const;

function cfg(stepScope: string | undefined) {
  return { configurable: { thread_id: "thread-1", ...(stepScope ? { step_scope: stepScope } : {}) } };
}

describe("github_read repeat guard, scoped to the step", () => {
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue({ success: true, data: [{ number: 1 }] });
  });

  it("two turns on one thread, 3 identical calls each within 90s: none of the 6 is blocked", async () => {
    for (const scope of ["turn-a:s1", "turn-b:s1"]) {
      for (let i = 0; i < 3; i++) {
        const out = await githubRead.invoke({ ...ARGS }, cfg(scope));
        expect(String(out)).not.toMatch(BLOCKED);
      }
    }
    expect(execute).toHaveBeenCalledTimes(6);
  });

  it("inside one step the 4th identical call is blocked and does no work", async () => {
    for (let i = 0; i < 3; i++) {
      expect(String(await githubRead.invoke({ ...ARGS }, cfg("turn-c:s1")))).not.toMatch(BLOCKED);
    }
    expect(String(await githubRead.invoke({ ...ARGS }, cfg("turn-c:s1")))).toMatch(BLOCKED);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("the block message does not claim a result sits in a context the next turn never sees", async () => {
    for (let i = 0; i < 3; i++) await githubRead.invoke({ ...ARGS }, cfg("turn-d:s1"));
    const out = String(await githubRead.invoke({ ...ARGS }, cfg("turn-d:s1")));
    expect(out).toMatch(/earlier in this step/i);
    expect(out).not.toMatch(/conversation above/i);
  });

  it("falls back to the thread when no step scope is passed (tests, scripts)", async () => {
    for (let i = 0; i < 3; i++) await githubRead.invoke({ ...ARGS, repo: "fallback" }, cfg(undefined));
    expect(String(await githubRead.invoke({ ...ARGS, repo: "fallback" }, cfg(undefined)))).toMatch(BLOCKED);
  });
});

describe("read_logs repeat guard, scoped to the step", () => {
  beforeEach(() => {
    readLogsExecute.mockReset();
    readLogsExecute.mockResolvedValue({ success: true, data: { lines: [] } });
  });

  it("two turns on one thread, 3 identical reads each: none blocked; 4th in one step blocked", async () => {
    for (const scope of ["turn-a:s1", "turn-b:s1"]) {
      for (let i = 0; i < 3; i++) {
        expect(String(await readLogs.invoke({ since: "1 hour ago" }, cfg(scope)))).not.toMatch(BLOCKED);
      }
    }
    expect(String(await readLogs.invoke({ since: "1 hour ago" }, cfg("turn-b:s1")))).toMatch(BLOCKED);
    expect(readLogsExecute).toHaveBeenCalledTimes(6);
  });
});
