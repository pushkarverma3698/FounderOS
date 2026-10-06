/**
 * run_command must run where the agent asked, and say why when it cannot.
 *
 * WHAT WAS BROKEN (prod, 2026-10-06). The founder asked the bot to review PR 79.
 * The agent passed cwd "~/Projects" (the tool's own schema suggests a ~/ path).
 * run_command joined that onto the root without expanding ~, so it ran in
 * /home/founderos/Projects/~/Projects, which does not exist. exec threw
 * "spawn /bin/sh ENOENT" with stderr "" and the catch kept the empty string
 * (`stderr ?? message`), so all three approved commands came back as a bare
 * "Command failed." and the model invented "gh is not authenticated".
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectWorkflowTool } from "../../../src/tools/project-workflow.js";

const ORIGINAL_HOME = process.env["HOME"];
let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "pw-cwd-")));
  mkdirSync(join(home, "Projects", "app"), { recursive: true });
  process.env["HOME"] = home;
  process.env["PROJECT_WORKFLOW_ROOT"] = join(home, "Projects");
});

afterEach(() => {
  process.env["HOME"] = ORIGINAL_HOME;
  delete process.env["PROJECT_WORKFLOW_ROOT"];
  rmSync(home, { recursive: true, force: true });
});

describe("run_command cwd", () => {
  it("expands a ~/ cwd to the real home directory — the PR 79 case", async () => {
    const res = await projectWorkflowTool.execute({ action: "run_command", command: "pwd", cwd: "~/Projects" });
    expect(res.success).toBe(true);
    expect(res.data).toBe(join(home, "Projects"));
  });

  it("resolves a bare project name against the root", async () => {
    const res = await projectWorkflowTool.execute({ action: "run_command", command: "pwd", cwd: "app" });
    expect(res.success).toBe(true);
    expect(res.data).toBe(join(home, "Projects", "app"));
  });

  it("names the missing directory instead of a bare 'Command failed.'", async () => {
    const res = await projectWorkflowTool.execute({ action: "run_command", command: "pwd", cwd: "~/Projects/nope" });
    expect(res.success).toBe(false);
    expect(res.error).toContain(join(home, "Projects", "nope"));
    expect(res.error).toMatch(/does not exist/);
  });

  it("keeps the exec error message when stderr is empty", async () => {
    const res = await projectWorkflowTool.execute({ action: "run_command", command: "exit 3", cwd: "~/Projects" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/exit|code 3|Command failed: exit 3/i);
    expect(res.error).not.toBe("Command failed.\n");
  });

  it("still denies a ~/ cwd outside the roots", async () => {
    mkdirSync(join(home, "elsewhere"));
    const res = await projectWorkflowTool.execute({ action: "run_command", command: "pwd", cwd: "~/elsewhere" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Access denied/);
  });
});
