/**
 * Unit tests — which coding CLI a task goes to, as far as the bot is concerned.
 *
 * The bot writes ~/.claude/coding-engine (/engine) and the VPS dispatcher reads the same file
 * (deploy/lib/engine.sh `engine_default`). The two readers must agree on every file content, or
 * the card names one CLI and the daemon runs the other. The parity cases below are the same
 * contents tests/unit/scripts/agent-dispatch-engine.test.ts feeds the bash reader.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  parseEngine,
  engineLabel,
  engineDisplay,
  engineFromCommand,
  readDefaultEngine,
  writeDefaultEngine,
  codingEngineFile,
} = await import("../../../src/tools/coding-engine.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "coding-engine-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("parseEngine", () => {
  it.each([
    ["claude", "claude"],
    ["Claude", "claude"],
    ["claude code", "claude"],
    ["Claude Code", "claude"],
    ["agy", "agy"],
    ["AGY", "agy"],
    ["antigravity", "agy"],
    ["  Antigravity  ", "agy"],
    ["Google Antigravity", "agy"],
  ])("reads %j as %s", (word, engine) => {
    expect(parseEngine(word)).toBe(engine);
  });

  it.each(["", "   ", "gemini", "codex", "claude-code-2", "both", "claudeagy", "agy claude"])(
    "refuses %j instead of guessing",
    (word) => {
      expect(parseEngine(word)).toBeUndefined();
    },
  );

  it("refuses a value that is not a string", () => {
    expect(parseEngine(undefined)).toBeUndefined();
    expect(parseEngine(null)).toBeUndefined();
    expect(parseEngine(7)).toBeUndefined();
  });
});

describe("names", () => {
  it("labels are the ones the daemon puts on a PR and onboard-repo.sh creates", () => {
    expect(engineLabel("agy")).toBe("engine:agy");
    expect(engineLabel("claude")).toBe("engine:claude");
  });

  it("display names are what the founder reads on the card", () => {
    // "Google Antigravity" is what the card has always said; the daemon's own Telegram lines say "Antigravity".
    expect(engineDisplay("agy")).toBe("Google Antigravity");
    expect(engineDisplay("claude")).toBe("Claude Code");
  });

  it("a display name parses back to its engine, so the force-reply prompt can carry it", () => {
    expect(parseEngine(engineDisplay("agy"))).toBe("agy");
    expect(parseEngine(engineDisplay("claude"))).toBe("claude");
  });
});

describe("engineFromCommand", () => {
  it.each([
    ["/claude fix the login", "claude"],
    ["/agy fix the login", "agy"],
    ["/claude@FounderOSBot fix the login", "claude"],
    ["/AGY@FounderOSBot fix the login", "agy"],
    ["/claude", "claude"],
    ["  /claude fix it", "claude"],
  ])("%j → %s", (text, engine) => {
    expect(engineFromCommand(text)).toBe(engine);
  });

  it.each(["/task fix the login", "fix the login", "", "/claudex fix it", "/agyy fix it", "please /claude this", "/engine claude"])(
    "%j → nothing: the command, not a prefix of a word, names the engine",
    (text) => {
      expect(engineFromCommand(text)).toBeUndefined();
    },
  );
});

describe("readDefaultEngine", () => {
  it("is agy when the file does not exist", () => {
    expect(readDefaultEngine(join(dir, "missing"))).toBe("agy");
  });

  // Same contents as the bash reader's table: engine_default in deploy/lib/engine.sh.
  it.each([
    ["claude\n", "claude"],
    ["claude", "claude"],
    ["  claude  \n", "claude"],
    ["claude\nagy\n", "claude"],
    ["agy\n", "agy"],
    ["", "agy"],
    ["\n", "agy"],
    ["Claude\n", "agy"],
    ["claude code\n", "agy"],
    ["gemini\n", "agy"],
    ["garbage\n", "agy"],
    ["\nclaude\n", "agy"],
  ])("file holding %j → %s", (content, engine) => {
    const file = join(dir, "coding-engine");
    writeFileSync(file, content);
    expect(readDefaultEngine(file)).toBe(engine);
  });

  it("a directory where the file should be is agy, not a crash", () => {
    expect(readDefaultEngine(dir)).toBe("agy");
  });
});

describe("writeDefaultEngine", () => {
  it("writes one word and a newline that the reader gives back", () => {
    const file = join(dir, "coding-engine");
    writeDefaultEngine("claude", file);
    expect(readFileSync(file, "utf8")).toBe("claude\n");
    expect(readDefaultEngine(file)).toBe("claude");
    writeDefaultEngine("agy", file);
    expect(readFileSync(file, "utf8")).toBe("agy\n");
    expect(readDefaultEngine(file)).toBe("agy");
  });

  it("creates the directory when ~/.claude does not exist yet", () => {
    const file = join(dir, "nested", ".claude", "coding-engine");
    writeDefaultEngine("claude", file);
    expect(readDefaultEngine(file)).toBe("claude");
  });

  it("leaves no temp file beside the target: the daemon never reads a half-written word", () => {
    const file = join(dir, "coding-engine");
    writeDefaultEngine("claude", file);
    writeDefaultEngine("agy", file);
    expect(readdirSync(dir)).toEqual(["coding-engine"]);
  });

  it("is readable by the dispatcher, which is a different process", () => {
    const file = join(dir, "coding-engine");
    writeDefaultEngine("claude", file);
    expect(statSync(file).mode & 0o444).toBe(0o444);
  });

  it("throws when the directory cannot be made, so /engine can say so instead of claiming success", () => {
    const blocker = join(dir, "a-file");
    writeFileSync(blocker, "");
    expect(() => writeDefaultEngine("claude", join(blocker, "coding-engine"))).toThrow();
  });

  it("throws and leaves no temp file when the rename fails", () => {
    // A non-empty directory sits where the file would be: rename onto it fails.
    const file = join(dir, "coding-engine");
    mkdirSync(file);
    writeFileSync(join(file, "child"), "");
    expect(() => writeDefaultEngine("claude", file)).toThrow();
    expect(readdirSync(dir)).toEqual(["coding-engine"]);
    expect(existsSync(join(file, "child"))).toBe(true);
  });
});

describe("codingEngineFile", () => {
  it("is ~/.claude/coding-engine: the path engine.sh reads", () => {
    expect(codingEngineFile()).toMatch(/[\\/]\.claude[\\/]coding-engine$/);
  });
});
