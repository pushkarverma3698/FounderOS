/**
 * Unit tests for /engine — show or switch the default coding CLI.
 *
 * The command writes ~/.claude/coding-engine, which the VPS dispatcher reads on its next tick. What
 * the founder is told must be what the file now holds, so every reply here is checked against a
 * fake file, and a write that did not take is reported rather than assumed.
 */

import { describe, it, expect } from "vitest";
import type { Context } from "grammy";

const { handleEngine } = await import("../../../src/gateway/engine-command.js");

type Engine = "agy" | "claude";

/** A one-word file in memory. `failWrite` throws; `dropWrite` accepts the call but changes nothing. */
function fakeFile(initial: Engine, mode: "ok" | "failWrite" | "dropWrite" = "ok") {
  const state = { value: initial, writes: [] as Engine[] };
  return {
    state,
    read: () => state.value,
    write: (engine: Engine) => {
      state.writes.push(engine);
      if (mode === "failWrite") throw new Error("EACCES: permission denied");
      if (mode === "ok") state.value = engine;
    },
  };
}

function fakeCtx(match: string): { ctx: Context; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    match,
    message: { message_id: 7, text: `/engine ${match}` },
    reply: async (text: string) => void replies.push(text),
  } as unknown as Context;
  return { ctx, replies };
}

describe("/engine with no argument", () => {
  it("shows the current default and how to change it, and writes nothing", async () => {
    const file = fakeFile("agy");
    const { ctx, replies } = fakeCtx("");

    await handleEngine(ctx, file);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(/Antigravity/);
    expect(replies[0]).toContain("/engine claude");
    expect(replies[0]).toContain("/claude");
    expect(file.state.writes).toEqual([]);
  });

  it("names Claude Code when that is the default", async () => {
    const { ctx, replies } = fakeCtx("   ");

    await handleEngine(ctx, fakeFile("claude"));

    expect(replies[0]).toMatch(/Claude Code/);
    expect(replies[0]).toContain("/engine agy");
  });
});

describe("/engine <name>", () => {
  it.each([
    ["claude", "claude", /Claude Code/],
    ["Claude", "claude", /Claude Code/],
    ["claude code", "claude", /Claude Code/],
    ["agy", "agy", /Antigravity/],
    ["antigravity", "agy", /Antigravity/],
    ["  AGY  ", "agy", /Antigravity/],
  ] as const)("%j sets the default to %s and says so", async (arg, engine, shown) => {
    const file = fakeFile(engine === "claude" ? "agy" : "claude");
    const { ctx, replies } = fakeCtx(arg);

    await handleEngine(ctx, file);

    expect(file.state.value).toBe(engine);
    expect(file.state.writes).toEqual([engine]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatch(shown);
    expect(replies[0]).toMatch(/default/i);
  });

  it("tells him tasks already filed keep the engine they were filed with", async () => {
    const { ctx, replies } = fakeCtx("claude");

    await handleEngine(ctx, fakeFile("agy"));

    expect(replies[0]).toMatch(/already filed/i);
  });

  it("confirms a switch to the engine that is already the default instead of staying silent", async () => {
    const file = fakeFile("claude");
    const { ctx, replies } = fakeCtx("claude");

    await handleEngine(ctx, file);

    expect(replies[0]).toMatch(/Claude Code/);
    expect(file.state.value).toBe("claude");
  });

  it("refuses a word it does not know, names the two it does, and writes nothing", async () => {
    const file = fakeFile("agy");
    const { ctx, replies } = fakeCtx("gemini");

    await handleEngine(ctx, file);

    expect(replies[0]).toContain("gemini");
    expect(replies[0]).toContain("/engine claude");
    expect(replies[0]).toContain("/engine agy");
    expect(file.state.writes).toEqual([]);
    expect(file.state.value).toBe("agy");
  });

  it("refuses two words rather than reading the first and ignoring the second", async () => {
    const file = fakeFile("agy");
    const { ctx, replies } = fakeCtx("claude agy");

    await handleEngine(ctx, file);

    expect(file.state.writes).toEqual([]);
    expect(replies[0]).toContain("/engine claude");
  });

  it("says the save failed, with the reason, and what the default still is", async () => {
    const file = fakeFile("agy", "failWrite");
    const { ctx, replies } = fakeCtx("claude");

    await handleEngine(ctx, file);

    expect(replies[0]).toMatch(/could not|couldn't|failed/i);
    expect(replies[0]).toContain("EACCES");
    expect(replies[0]).toMatch(/Antigravity/);
    expect(replies[0]).not.toMatch(/is now Claude Code/);
  });

  it("does not claim success when the write returned but the file still holds the old word", async () => {
    // Evidence over assertion: the reply reads the file back.
    const file = fakeFile("agy", "dropWrite");
    const { ctx, replies } = fakeCtx("claude");

    await handleEngine(ctx, file);

    expect(replies[0]).toMatch(/could not|couldn't|failed|did not/i);
    expect(replies[0]).not.toMatch(/is now Claude Code/);
  });
});
