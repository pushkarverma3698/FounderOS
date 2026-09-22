/**
 * A model-invented home directory must not break a valid workspace request.
 *
 * THE INCIDENT (2026-09-22 20:30, production). The founder asked "Ping claude and
 * check what all models are available". The worker called claude_code with
 * cwd="/home/pushkar/Projects/agent-workspace" — a username that exists nowhere on
 * the box. The real service runs as HOME=/home/founderos and
 * /home/founderos/Projects/agent-workspace EXISTS. The tool answered:
 *
 *   "Access denied: cwd /home/pushkar/Projects/agent-workspace is outside ~/Projects."
 *
 * and FounderOS reported the engineering capability broken.
 *
 * The model has no way to know the host's home directory and no reason to: the
 * schema says "Working directory within ~/Projects", which is a statement about a
 * PROJECT, not about a filesystem. An absolute path naming a Projects segment is
 * therefore resolved against the real ~/Projects instead of being refused for
 * disagreeing about the prefix.
 *
 * Containment is unchanged — every re-rooted path still passes through
 * isProjectPath() and the self-repo refusal, and both are asserted below. The
 * re-rooting removes a failure mode, never a guard.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExecutorCwd } from "../../../src/tools/claude-code.js";

let home: string;
let realHome: string | undefined;

beforeEach(() => {
  realHome = process.env["HOME"];
  home = mkdtempSync(join(tmpdir(), "fos-home-"));
  mkdirSync(join(home, "Projects"), { recursive: true });
  process.env["HOME"] = home;
});

afterEach(() => {
  if (realHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = realHome;
  rmSync(home, { recursive: true, force: true });
});

describe("resolveExecutorCwd — foreign home prefixes", () => {
  // Verbatim from the 2026-09-22 production trace.
  it("re-roots the exact invented path that failed in production", () => {
    const res = resolveExecutorCwd("/home/pushkar/Projects/agent-workspace");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.cwd).toBe(join(home, "Projects/agent-workspace"));
  });

  it.each([
    ["/Users/pushkarverma/Projects/demo", "demo"],
    ["/home/ubuntu/Projects/nested/deep", "nested/deep"],
    ["/root/Projects/x", "x"],
  ])("re-roots %s under the real home", (given, suffix) => {
    const res = resolveExecutorCwd(given);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.cwd).toBe(join(home, "Projects", suffix));
  });

  it("leaves a correct absolute path alone", () => {
    const res = resolveExecutorCwd(join(home, "Projects/already-right"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.cwd).toBe(join(home, "Projects/already-right"));
  });

  it("still defaults to the agent workspace when no cwd is given", () => {
    const res = resolveExecutorCwd(undefined);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.cwd).toBe(join(home, "Projects/agent-workspace"));
  });
});

describe("resolveExecutorCwd — guards survive re-rooting", () => {
  it("still refuses the FounderOS repo when it arrives under a foreign home", () => {
    const res = resolveExecutorCwd("/home/pushkar/Projects/founderos");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/may not run inside the FounderOS repo/i);
  });

  it("still refuses a path with no Projects segment", () => {
    const res = resolveExecutorCwd("/etc");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/outside ~\/Projects/i);
  });

  it("still refuses traversal that escapes ~/Projects after re-rooting", () => {
    const res = resolveExecutorCwd("/home/pushkar/Projects/../../../etc/ssh");
    expect(res.ok).toBe(false);
  });

  it("does not re-root a path whose Projects segment is not a directory boundary", () => {
    const res = resolveExecutorCwd("/var/ProjectsData/thing");
    expect(res.ok).toBe(false);
  });
});
