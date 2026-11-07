/**
 * `verify-pr-scope` — a PR that adds code or scripts names what was checked first.
 * Founder 2026-10-13: agents built team-shift, chief-run and a host cron scheduler that OpenDots already had natively
 * (scheduled tasks, computers), and days went into them. The 30-day freeze and its `Moves:` line ended 2026-11-01.
 */

import { describe, it, expect } from "vitest";
import { evaluatePrScope, newBuildFiles, parseCheckedFirst } from "../../../scripts/verify-pr-scope.js";

const CHECKED = "## What changed\nx\n\nChecked first: grep -rn scheduler src/ and the OpenDots docs; native scheduled tasks exist, so none built.\n";

describe("Checked first", () => {
  it("reads the line, ignoring the template's HTML-comment placeholder", () => {
    expect(parseCheckedFirst("Checked first: grep found nothing")).toBe("grep found nothing");
    expect(parseCheckedFirst("Checked first: <!-- what you searched -->")).toBe("");
    expect(parseCheckedFirst("no line")).toBe("");
  });
  it("counts new code and scripts, never tests, docs or markdown", () =>
    expect(newBuildFiles(["src/a.ts", "deploy/x/run", "tests/unit/a.test.ts", "docs/plans/p.md", "README.md"])).toEqual(["src/a.ts", "deploy/x/run"]));
  it("fails a PR that adds a script with no Checked first line, and names the file", () => {
    const r = evaluatePrScope({ added: ["deploy/opendots/team-shift"], body: "no line", headRef: "feat/x" });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toContain("deploy/opendots/team-shift");
    expect(r.problems.join("\n")).toContain("Checked first:");
  });
  it("fails a one-word Checked first line", () =>
    expect(evaluatePrScope({ added: ["src/a.ts"], body: "Checked first: yes\n", headRef: "feat/x" }).ok).toBe(false));
  it("passes with a real Checked first line, or when only tests and docs are added", () => {
    expect(evaluatePrScope({ added: ["src/a.ts"], body: CHECKED, headRef: "feat/x" }).ok).toBe(true);
    expect(evaluatePrScope({ added: ["tests/unit/a.test.ts", "docs/plans/p.md"], body: "", headRef: "fix/x" }).ok).toBe(true);
  });
  it("needs no Moves line and has no frozen paths any more", () =>
    expect(evaluatePrScope({ added: [], body: "", headRef: "fix/jobhunt-pings" }).ok).toBe(true));
});

describe("exemptions", () => {
  it("exempts sync and promotion PRs, whose content was gated on the way in", () => {
    for (const headRef of ["main", "beta", "chore/promote-where-status", "chore/sync-beta"]) {
      expect(evaluatePrScope({ added: ["src/a.ts"], body: "", headRef }).ok).toBe(true);
    }
  });
  it("does not exempt an ordinary chore/ branch", () =>
    expect(evaluatePrScope({ added: ["src/a.ts"], body: "", headRef: "chore/tidy" }).ok).toBe(false));
});
