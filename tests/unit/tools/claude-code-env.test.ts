import { describe, expect, it } from "vitest";
import { buildExecutorEnv } from "../../../src/tools/claude-code.js";

describe("buildExecutorEnv with the /login claude token", () => {
  const base = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "bot-critic-key", CLAUDE_CODE_OAUTH_TOKEN: "stale-from-bot-env", CLAUDECODE: "1" };

  it("strips every inherited Anthropic/Claude credential, then sets only the stored token", () => {
    const env = buildExecutorEnv(base, "sk-ant-oat01-STORED");
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBe("sk-ant-oat01-STORED");
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["CLAUDECODE"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("without a stored token nothing Claude-related is passed (the CLI's own login is used, as before)", () => {
    const env = buildExecutorEnv(base);
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("an explicit CLAUDE_EXECUTOR_API_KEY wins over the stored token", () => {
    const env = buildExecutorEnv({ ...base, CLAUDE_EXECUTOR_API_KEY: "exec-key" }, "sk-ant-oat01-STORED");
    expect(env["ANTHROPIC_API_KEY"]).toBe("exec-key");
    expect(env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
  });
});
