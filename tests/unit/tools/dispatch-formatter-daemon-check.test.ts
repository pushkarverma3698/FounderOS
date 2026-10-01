/**
 * The two halves of the intake gate must agree about the issue the /task tool really files.
 * =========================================================================================
 * The brief lint (src/tools/agent-brief-lint.ts) runs before the approval card and again before
 * `issues.create`. The dispatcher's claim-time check (`agent-dispatch --check-brief`, deploy/agent-dispatch)
 * runs on the VPS before it claims an issue, and labels `agent:needs-brief` anything it rejects.
 * They were written and tested apart, on two branches. The failure this pins: the /task formatter once
 * emitted 7 of the 9 template sections, so the TypeScript lint would have rejected every /task call
 * and the daemon would have refused every /task issue it was handed, and neither half's own tests could
 * have seen it. Here the REAL formatter's output goes through BOTH real checks.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "../../../src/evolution/repo-root.js";
import { lintAgentBrief } from "../../../src/tools/agent-brief-lint.js";
import { checkoutFileExists } from "../../../src/tools/dispatch-brief-check.js";
import { formatAntigravityIssueBody, type AntigravityTaskInput } from "../../../src/tools/dispatch-antigravity.js";

const DAEMON = fileURLToPath(new URL("../../../deploy/agent-dispatch", import.meta.url));

/** A complete brief: every file it names exists in this checkout. */
const COMPLETE: AntigravityTaskInput = {
  title: "Make the lint say which section is empty",
  goal: "The brief lint must name the empty section, not only the missing ones.",
  problem: "A heading with no text under it is reported as present, so the planner never asks for it.",
  evidence: "`tests/unit/tools/agent-brief-lint.test.ts` has no case for a heading whose body is only whitespace.",
  scope: "`src/tools/agent-brief-lint.ts` and `tests/unit/tools/agent-brief-lint.test.ts`.",
  expected: "A heading whose body is empty is reported as missing, with the heading's name.",
  verification: "pnpm vitest run tests/unit/tools/agent-brief-lint.test.ts",
};

/** What the TypeScript lint says is incomplete, as a set of heading names. */
async function lintIncomplete(input: AntigravityTaskInput): Promise<{ ok: boolean; sections: string[] }> {
  const result = await lintAgentBrief(formatAntigravityIssueBody(input), checkoutFileExists(repoRoot()));
  const text = JSON.stringify(result.missing);
  const sections = ["Problem / observed behavior", "Evidence", "Constraints", "Goal", "Expected behavior"].filter((h) => text.includes(h));
  return { ok: result.ok, sections };
}

/** What the daemon's claim-time check says, as `missing:`/`empty:` lines. */
function daemonVerdict(input: AntigravityTaskInput): { status: number | null; sections: string[] } {
  const home = mkdtempSync(join(tmpdir(), "formatter-daemon-"));
  try {
    const r = spawnSync("bash", [DAEMON, "--check-brief"], {
      input: formatAntigravityIssueBody(input),
      env: { PATH: "/usr/bin:/bin:/usr/local/bin", HOME: home },
      encoding: "utf8",
      timeout: 20_000,
    });
    const sections = r.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => line.replace(/^(missing|empty): /, ""));
    return { status: r.status, sections };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("the /task formatter's real output, through both real checks", () => {
  it("a complete input passes the TypeScript lint AND the daemon's claim-time check", async () => {
    expect((await lintIncomplete(COMPLETE)).ok).toBe(true);
    expect(daemonVerdict(COMPLETE)).toEqual({ status: 0, sections: [] });
  });

  it("a brief without evidence is incomplete to BOTH, and both name Evidence", async () => {
    const input = { ...COMPLETE, evidence: undefined };
    const lint = await lintIncomplete(input);
    const daemon = daemonVerdict(input);
    expect(lint.ok).toBe(false);
    expect(lint.sections).toContain("Evidence");
    expect(daemon.status).toBe(1);
    expect(daemon.sections).toEqual(["Evidence"]);
  });

  it("a brief without a problem statement is incomplete to BOTH, and both name it", async () => {
    const input = { ...COMPLETE, problem: undefined };
    const lint = await lintIncomplete(input);
    const daemon = daemonVerdict(input);
    expect(lint.ok).toBe(false);
    expect(lint.sections).toContain("Problem / observed behavior");
    expect(daemon.status).toBe(1);
    expect(daemon.sections).toEqual(["Problem / observed behavior"]);
  });

  it("the standing constraints alone fill the Constraints section: a founder who adds none is not asked for any", async () => {
    // Constraints is the one section the formatter fills with real, standing content (STANDING_CONSTRAINTS).
    expect((await lintIncomplete(COMPLETE)).sections).not.toContain("Constraints");
    expect(daemonVerdict(COMPLETE).sections).not.toContain("Constraints");
  });

  it("when the two checks reject, they reject the same sections", async () => {
    for (const input of [
      { ...COMPLETE, evidence: undefined },
      { ...COMPLETE, problem: undefined },
      { ...COMPLETE, evidence: undefined, problem: undefined },
    ]) {
      const lint = (await lintIncomplete(input)).sections.sort();
      const daemon = daemonVerdict(input).sections.sort();
      expect(daemon).toEqual(lint);
    }
  });
});
