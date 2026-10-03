import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/infra/logger.js", () => ({
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { classifyClaudeResult, verifyClaudeToken } from "../../../../src/gateway/login/adapters/claude.js";

// Captured 2026-10-04 with `CLAUDE_CODE_OAUTH_TOKEN=<made-up> claude -p "reply ok" --max-turns 1 --output-format json` in an empty HOME.
const REJECTED_401 = JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 401, result: "Failed to authenticate. API Error: 401 OAuth access token is invalid." });
const OK = JSON.stringify({ type: "result", subtype: "success", is_error: false, api_error_status: null, result: "ok" });

describe("classifyClaudeResult", () => {
  it("is_error false is ok", () => expect(classifyClaudeResult(OK, 0)).toEqual({ kind: "ok" }));
  it("the captured 401 is rejected", () => expect(classifyClaudeResult(REJECTED_401, 1)).toEqual({ kind: "rejected" }));
  it("a usage limit proves the token authenticates", () => {
    const r = classifyClaudeResult(JSON.stringify({ is_error: true, api_error_status: 429, result: "You've hit your usage limit" }), 1);
    expect(r.kind).toBe("ok");
  });
  it("garbage and empty output are unknown, never ok", () => {
    expect(classifyClaudeResult("", 1).kind).toBe("unknown");
    expect(classifyClaudeResult("not json", 0).kind).toBe("unknown");
  });
  it("an unrecognised error is unknown, not rejected", () => {
    expect(classifyClaudeResult(JSON.stringify({ is_error: true, api_error_status: 500, result: "overloaded" }), 1).kind).toBe("unknown");
  });
});

function fakeSpawn(stdout: string, code: number) {
  const calls: Array<{ cmd: string; args: readonly string[]; env: Record<string, string>; cwd: string }> = [];
  const spawnFn = ((cmd: string, args: readonly string[], opts: { env: Record<string, string>; cwd: string }) => {
    calls.push({ cmd, args, env: opts.env, cwd: opts.cwd });
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: vi.fn() });
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", code);
    });
    return child;
  }) as never;
  return { spawnFn, calls };
}

describe("verifyClaudeToken", () => {
  it("runs one cheap claude call with only this token, an empty HOME, and the token never in argv", async () => {
    const f = fakeSpawn(OK, 0);
    const r = await verifyClaudeToken("sk-ant-oat01-TESTTOKEN", f.spawnFn, { PATH: "/usr/bin", ANTHROPIC_API_KEY: "bot-key", CLAUDE_CODE_OAUTH_TOKEN: "other" });
    expect(r).toEqual({ kind: "ok" });
    const c = f.calls[0]!;
    expect(c.cmd).toBe("claude");
    expect(c.args).toEqual(["-p", "reply ok", "--max-turns", "1", "--output-format", "json"]);
    expect(c.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-ant-oat01-TESTTOKEN");
    expect(Object.keys(c.env).sort()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "HOME", "PATH", "TERM"]);
    expect(c.env["HOME"]).toBe(c.cwd);
    expect(JSON.stringify(c.args)).not.toContain("TESTTOKEN");
  });

  it("maps the captured 401 to rejected", async () => {
    const f = fakeSpawn(REJECTED_401, 1);
    expect(await verifyClaudeToken("sk-ant-oat01-x", f.spawnFn, { PATH: "/usr/bin" })).toEqual({ kind: "rejected" });
  });
});
