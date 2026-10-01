/**
 * Claim-time intake: an issue that is not a complete brief is not claimed —
 * deploy/agent-dispatch.
 * =========================================================================
 * The one real feature this loop ever shipped, #762 "Jev AI", was implemented from a brief
 * that named a file which does not exist. Nothing checked the issue body against the template
 * before agent:ready started an unattended run. A human-filed issue that is missing a section
 * (or has one that says nothing) is now refused at claim time: agent:needs-brief, ONE comment
 * listing what is missing, ONE Telegram message, and no Antigravity run.
 *
 * The property the founder feels is the "once": re-checking an issue that already carries the
 * label must not comment or message again, however many ticks pass.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AGENT_LABELS, BRIEF_HEADINGS, DispatchSandbox, goodBrief } from "./dispatch-sandbox.js";

const NEEDS_BRIEF = "agent:needs-brief";
const TRANSIENT = "Error: timeout waiting for response"; // verbatim: the run ends without a PR, no other side effect

let sb: DispatchSandbox;

const withoutSections = (...names: string[]): string =>
  BRIEF_HEADINGS.filter((h) => !names.includes(h))
    .map((h) => `## ${h}\n\nSomething concrete for ${h}.\n`)
    .join("\n");

/** Evidence missing, Constraints present but empty: the shape #762 would have had. */
const incompleteBrief = (): string =>
  BRIEF_HEADINGS.filter((h) => h !== "Evidence")
    .map((h) => `## ${h}\n\n${h === "Constraints" ? "<!-- Anything that shapes the fix. -->" : `Something concrete for ${h}.`}\n`)
    .join("\n");

const flagged = () => sb.commentsOf(710).filter((c) => c.includes("<!-- agent-needs-brief -->"));
const refusals = () => sb.messages().filter((m) => /did NOT claim/.test(m));

beforeEach(() => {
  sb = new DispatchSandbox(["owner/founderos"]);
});

afterEach(() => {
  sb.destroy();
});

describe("a human-filed issue with an incomplete brief", () => {
  beforeEach(() => {
    sb.addIssue({ number: 710, title: "fix(x): a half-written task", body: incompleteBrief() });
  });

  it("gets agent:needs-brief and loses agent:ready, and no Antigravity run starts", () => {
    sb.tick({ agyOut: TRANSIENT });

    expect(sb.labelsOf(710)).toEqual([NEEDS_BRIEF]);
    expect(sb.agyRuns()).toBe(0);
    expect(sb.ghLog()).not.toMatch(/--add-label agent:working/);
    expect(sb.commentsOf(710).some((c) => c.includes("agent-claimed"))).toBe(false);
  });

  it("gets ONE comment that lists exactly what is missing and what is empty", () => {
    sb.tick();

    expect(flagged()).toHaveLength(1);
    expect(flagged()[0]).toContain("`## Evidence` is missing");
    expect(flagged()[0]).toContain("`## Constraints` is empty");
    expect(flagged()[0]).toContain(".github/ISSUE_TEMPLATE/agent-task.md");
    expect(flagged()[0]).toContain("agent:ready");
    // Nothing else is reported: every other section is fine.
    expect(flagged()[0]).not.toContain("`## Goal`");
  });

  it("sends ONE Telegram message naming the issue, the repo, each problem and the fix", () => {
    sb.tick();

    expect(sb.messages()).toHaveLength(1);
    const msg = sb.messages()[0] ?? "";
    expect(msg).toContain("#710");
    expect(msg).toContain("owner/founderos");
    expect(msg).toContain("## Evidence (missing)");
    expect(msg).toContain("## Constraints (empty)");
    expect(msg).toMatch(/put agent:ready back/);
  });

  it("is not re-commented or re-messaged on any later tick", () => {
    for (let i = 0; i < 5; i++) sb.tick();

    expect(flagged()).toHaveLength(1);
    expect(refusals()).toHaveLength(1);
    expect(sb.agyRuns()).toBe(0);
  });

  it("when agent:ready is re-applied without fixing the brief, only agent:ready comes off again: no new comment, no new message", () => {
    sb.tick();
    // The founder re-adds the label but leaves the body as it was; the flag from the first refusal is still on.
    sb.addIssue({
      number: 710,
      title: "fix(x): a half-written task",
      body: incompleteBrief(),
      labels: ["agent:ready", NEEDS_BRIEF],
      comments: sb.commentsOf(710),
    });
    sb.tick();
    sb.tick();

    expect(sb.labelsOf(710)).toEqual([NEEDS_BRIEF]);
    expect(flagged()).toHaveLength(1);
    expect(refusals()).toHaveLength(1);
    expect(sb.log()).toMatch(/already carries agent:needs-brief.*no new comment or message/);
    expect(sb.agyRuns()).toBe(0);
  });

  it("once the brief is fixed and agent:ready is back, it is claimed normally and the stale flag comes off", () => {
    sb.tick();
    sb.addIssue({
      number: 710,
      title: "fix(x): a half-written task",
      body: goodBrief(),
      labels: ["agent:ready", NEEDS_BRIEF],
      comments: sb.commentsOf(710),
    });
    sb.tick({ agyOut: TRANSIENT });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.labelsOf(710)).not.toContain(NEEDS_BRIEF);
    expect(sb.labelsOf(710)).toEqual(["agent:ready"]); // the run ended transient and went back to the queue
    expect(sb.log()).toMatch(/brief is complete now/);
  });

  it("a forced claim (--issue N, what /task's kick uses) is refused the same way", () => {
    sb.tick({ args: ["--issue", "710"] });

    expect(sb.labelsOf(710)).toEqual([NEEDS_BRIEF]);
    expect(sb.agyRuns()).toBe(0);
    expect(refusals()).toHaveLength(1);
  });

  it("--dry-run says what it would do and changes nothing", () => {
    sb.tick({ args: ["--dry-run"] });

    expect(sb.log()).toMatch(/DRY RUN would not claim #710.*## Evidence \(missing\), ## Constraints \(empty\)/);
    expect(sb.labelsOf(710)).toEqual(["agent:ready"]);
    expect(sb.messages()).toEqual([]);
    expect(sb.commentsOf(710)).toEqual([]);
    expect(sb.ghLog()).not.toMatch(/issue edit|issue comment|label create/);
  });
});

describe("what does and does not count as a complete brief", () => {
  it("claims a complete brief (control: the gate does not over-reject)", () => {
    sb.addIssue({ number: 710, body: goodBrief() });
    sb.tick({ agyOut: TRANSIENT });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.ghLog()).toMatch(/--add-label agent:working/);
    expect(flagged()).toHaveLength(0);
  });

  it("claims a complete brief that arrives with CRLF line endings (GitHub's web editor)", () => {
    sb.addIssue({ number: 710, body: goodBrief().replace(/\n/g, "\r\n") });
    sb.tick({ agyOut: TRANSIENT });
    expect(sb.agyRuns()).toBe(1);
  });

  it("refuses the unedited issue template: every section is only its guidance comment", () => {
    const template = readFileSync(fileURLToPath(new URL("../../../.github/ISSUE_TEMPLATE/agent-task.md", import.meta.url)), "utf8").replace(
      /^---\n[\s\S]*?\n---\n/,
      "",
    );
    sb.addIssue({ number: 710, body: template });
    sb.tick();

    expect(sb.agyRuns()).toBe(0);
    for (const h of BRIEF_HEADINGS) expect(flagged()[0]).toContain(`\`## ${h}\` is empty`);
  });

  it("refuses an issue with no body at all", () => {
    sb.addIssue({ number: 710, body: "" });
    sb.tick();

    expect(sb.labelsOf(710)).toEqual([NEEDS_BRIEF]);
    expect(flagged()[0]).toContain("`## Goal` is missing");
  });
});

describe("the queue behind a refused brief", () => {
  it("a refused brief does not hold up a good one queued behind it: both are handled in the SAME tick", () => {
    sb.addIssue({ number: 5, body: withoutSections("Goal") });
    sb.addIssue({ number: 6, body: goodBrief() });
    sb.tick({ agyOut: TRANSIENT });

    expect(sb.labelsOf(5)).toEqual([NEEDS_BRIEF]);
    expect(sb.agyRuns()).toBe(1);
    expect(sb.commentsOf(6).some((c) => c.includes("agent-claimed"))).toBe(true);
  });

  it("looks at no more than MAX_BRIEF_CHECKS refused briefs in one tick, then carries on next tick", () => {
    const max = Number(/^MAX_BRIEF_CHECKS=(\d+)/m.exec(readFileSync(sb.daemonPath(), "utf8"))?.[1]);
    expect(max).toBeGreaterThan(0);
    const total = max + 2;
    for (let n = 1; n <= total; n++) sb.addIssue({ number: n, body: withoutSections("Goal") });

    sb.tick();
    const flaggedAfterFirst = Array.from({ length: total }, (_, i) => i + 1).filter((n) => sb.labelsOf(n).includes(NEEDS_BRIEF));
    expect(flaggedAfterFirst).toHaveLength(max);

    sb.tick();
    const flaggedAfterSecond = Array.from({ length: total }, (_, i) => i + 1).filter((n) => sb.labelsOf(n).includes(NEEDS_BRIEF));
    expect(flaggedAfterSecond).toHaveLength(total);
  });
});

describe("the agent:needs-brief label itself", () => {
  it("is created on demand in a repo that was onboarded before it existed, then applied", () => {
    sb.setRepoLabels("owner/founderos", AGENT_LABELS.filter((l) => l !== NEEDS_BRIEF));
    sb.addIssue({ number: 710, body: withoutSections("Goal") });
    sb.tick();

    expect(sb.repoLabels()).toContain(NEEDS_BRIEF);
    expect(sb.labelsOf(710)).toEqual([NEEDS_BRIEF]);
    expect(sb.ghLog()).toMatch(/label create agent:needs-brief .*--force/);
  });

  it("if GitHub rejects the label swap, NOTHING is sent (no spam) and the tick still ends cleanly", () => {
    sb.addIssue({ number: 710, body: withoutSections("Goal") });
    sb.patchGh({ failIssueEdit: true });
    const r = sb.tick();
    sb.tick();
    sb.tick();

    expect(r.status).toBe(0);
    expect(sb.messages()).toEqual([]);
    expect(flagged()).toHaveLength(0);
    expect(sb.log()).toMatch(/could not be labelled agent:needs-brief/);
    expect(sb.log()).toMatch(/tick complete/);
  });

  it("a Telegram outage does not change the state: the label and the comment still land", () => {
    sb.addIssue({ number: 710, body: withoutSections("Goal") });
    sb.tick({ curlRc: 22 });
    sb.tick({ curlRc: 22 });

    expect(sb.labelsOf(710)).toEqual([NEEDS_BRIEF]);
    expect(flagged()).toHaveLength(1);
  });
});
