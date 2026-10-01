/**
 * Unit tests — the daily Telegram line (plan C3).
 * ================================================
 * ALWAYS SENT, one of: "Jobhunt check: filed #N <title>", "Jobhunt check: nothing
 * new", "Jobhunt check: check failed: <reason>". Silence is indistinguishable from
 * "nothing to report", which is how the last acting loop could be dead for weeks
 * while looking healthy (dispatch-sweep.ts: IT ALWAYS SENDS).
 *
 * Founder-facing rules (CLAUDE.md #26): every reason printed with its own result,
 * split across messages rather than truncated, and it ends in something to do.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  renderJobhuntCheck,
  type JobhuntCheckReport,
} from "../../../src/evolution/jobhunt-message.js";
import { ADAPTER_SILENT_MIN_SWEEP_RUNS, type JobhuntCoverage } from "../../../src/evolution/analyzers/jobhunt.js";
import { TELEGRAM_MAX_CHARS } from "../../../src/tools/jobhunt/telegram-format.js";
import type { Finding } from "../../../src/evolution/types.js";

const COVERAGE: JobhuntCoverage = {
  sweepRuns24h: 96,
  newPostings7d: 1204,
  platformsJudged: ["ashby", "greenhouse", "lever"],
  platformsKnown: 10,
  profilesChecked: 2,
};

const notActing: Finding = {
  kind: "candidate-not-acting",
  subject: "wife-nl-finance",
  evidence:
    "wife-nl-finance (Tashi Goyal) has 62 actionable roles from the last 14 days (28 do today, 14 stretch, 20 ask), " +
    "0 applied and 0 skipped: nothing shows the candidate has seen them.",
  severity: "high",
};
const laneSilent: Finding = {
  kind: "lane-silent",
  subject: "pushkar-nl-tech",
  evidence: "pushkar-nl-tech (Pushkar): 0 new postings reached screening for 9 consecutive free-lane sweeps (about 4.5 hours).",
  severity: "medium",
};
const filedFinding: Finding = {
  kind: "adapter-silent",
  subject: "ashby (no new postings since 2026-09-26)",
  evidence: "ashby produced 0 new postings in the last 24h after 100 in the 7 days before.",
  severity: "high",
  location: "src/tools/jobhunt/adapters/ashby.ts",
};

function report(over: Partial<JobhuntCheckReport> = {}): JobhuntCheckReport {
  return { outcome: { state: "nothing-dispatchable", totalFindings: 0 }, coverage: COVERAGE, due: [], quiet: [], ...over };
}

const text = (r: JobhuntCheckReport): string => renderJobhuntCheck(r).join("\n\n");
const firstLine = (r: JobhuntCheckReport): string => renderJobhuntCheck(r)[0]!.split("\n")[0]!.replace(/<\/?b>/g, "");

describe("the first line is one of the three the plan names", () => {
  it("filed: 'Jobhunt check: filed #N <title>'", () => {
    const line = firstLine(
      report({
        outcome: { state: "filed", finding: filedFinding, fingerprint: "a".repeat(64), issueNumber: 501, url: "https://github.com/x/y/issues/501" },
      }),
    );
    expect(line).toBe("Jobhunt check: filed #501 [self-audit] adapter-silent: ashby (no new postings since 2026-09-26)");
  });

  it("nothing new: 'Jobhunt check: nothing new'", () => {
    expect(firstLine(report())).toBe("Jobhunt check: nothing new");
  });

  it("nothing new also covers 'everything already has an issue'", () => {
    expect(firstLine(report({ outcome: { state: "all-filed", dispatchableCount: 2 } }))).toBe("Jobhunt check: nothing new");
  });

  it("failed: 'Jobhunt check: check failed: <reason>', never 'nothing new'", () => {
    const r = report({ outcome: { state: "failed", reason: "reading job_applications failed: connect ECONNREFUSED" }, coverage: null });
    expect(firstLine(r)).toBe("Jobhunt check: check failed: reading job_applications failed: connect ECONNREFUSED");
    expect(text(r)).not.toMatch(/nothing new/i);
  });

  it("a failed check says it filed nothing and that this is not a clean result", () => {
    const t = text(report({ outcome: { state: "failed", reason: "boom" }, coverage: null }));
    expect(t).toMatch(/nothing was filed/i);
    expect(t).toMatch(/not a clean result/i);
  });

  it("halted is its own line, says why nothing ran, and how to resume", () => {
    const r = report({ outcome: { state: "halted", reason: "deploying", engagedAt: "2026-09-29T03:00:00Z" }, coverage: null });
    expect(firstLine(r)).toMatch(/^Jobhunt check: skipped/);
    expect(text(r)).toContain("deploying");
    expect(text(r)).toContain("/resume");
    expect(text(r)).not.toMatch(/nothing new/i);
  });

  it("the kill switch is named, not silent", () => {
    const r = report({ outcome: { state: "disabled" } });
    expect(firstLine(r)).toMatch(/^Jobhunt check: filing is switched off/);
    expect(text(r)).toContain("SELF_IMPROVE_DISPATCH_ENABLED");
  });
});

describe("a filed issue ends in what the founder can do", () => {
  const filed = report({
    outcome: { state: "filed", finding: filedFinding, fingerprint: "a".repeat(64), issueNumber: 501, url: "https://github.com/x/y/issues/501" },
  });

  it("links the issue, quotes the evidence, and names the one thing only he can do", () => {
    const t = text(filed);
    expect(t).toContain('href="https://github.com/x/y/issues/501"');
    expect(t).toContain("ashby produced 0 new postings");
    expect(t).toMatch(/You only act at the merge/);
    expect(t).toContain("gh issue edit 501 --remove-label agent:ready");
  });
});

describe("what was checked is printed, so 'nothing new' is not an unfalsifiable claim", () => {
  it("says how many platforms, sweep runs and postings were looked at", () => {
    const t = text(report());
    expect(t).toContain("3 of 10 platforms");
    expect(t).toContain("ashby, greenhouse, lever");
    expect(t).toContain("96 free-sweep runs");
    expect(t).toContain("1,204 new postings");
  });

  it("warns loudly when the sweep barely ran, instead of implying a clean bill", () => {
    const t = text(report({ coverage: { ...COVERAGE, sweepRuns24h: 3 } }));
    expect(t).toContain("Only 3 free-sweep runs");
    expect(t).toContain(String(ADAPTER_SILENT_MIN_SWEEP_RUNS));
    expect(t).toMatch(/platform checks were skipped/i);
  });

  it("says so when no postings were stored at all, because a blind sensor must not read as a quiet market", () => {
    const t = text(report({ coverage: { ...COVERAGE, newPostings7d: 0, platformsJudged: [] } }));
    expect(t).toContain("No new postings were stored in the last 7 days");
    expect(t).toMatch(/nothing to read/i);
    expect(t).toContain("free-ats-ingest");
  });

  it("does not raise that warning on a normal day", () => {
    expect(text(report())).not.toContain("No new postings were stored");
  });

  it("says when no platform had enough volume to judge", () => {
    expect(text(report({ coverage: { ...COVERAGE, platformsJudged: [] } }))).toContain("0 of 10 platforms");
  });
});

describe("decisions", () => {
  it("are printed with their own evidence and marked Telegram-only", () => {
    const t = text(report({ due: [notActing] }));
    expect(t).toMatch(/Decisions for you/);
    expect(t).toMatch(/no issue is filed/i);
    expect(t).toContain("62 actionable roles");
    expect(t).toContain("candidate-not-acting");
  });

  it("the first line stays 'nothing new' even when a decision is due, because nothing was filed", () => {
    expect(firstLine(report({ due: [notActing] }))).toBe("Jobhunt check: nothing new");
  });

  it("end in a command: Tashi's own brief and applied commands for her profile", () => {
    const t = text(report({ due: [notActing] }));
    expect(t).toContain("/wife_today");
    expect(t).toContain("/wife_applied N");
  });

  it("use the plain commands for the founder's own profile", () => {
    const t = text(report({ due: [{ ...notActing, subject: "pushkar-nl-tech", evidence: "pushkar-nl-tech: 30 actionable, 0 applied" }] }));
    expect(t).toContain("/today");
    expect(t).toContain("/applied N");
    expect(t).not.toContain("/wife_");
  });

  it("lane-silent points at the jobs list and how to read the closing stage", () => {
    const t = text(report({ due: [laneSilent] }));
    expect(t).toContain("lane-silent");
    expect(t).toContain("/jobs");
    expect(t).toMatch(/already known in tracker|filter/i);
  });

  it("a decision already told inside the window is NOT repeated in full, but its existence and next reminder are stated", () => {
    const t = text(report({ quiet: [{ finding: notActing, nextReminderAt: new Date("2026-10-06T04:00:00Z") }] }));
    expect(t).not.toContain("62 actionable roles");
    expect(t).toContain("candidate-not-acting");
    expect(t).toContain("wife-nl-finance");
    expect(t).toContain("2026-10-06");
  });

  it("escapes finding text, which can contain angle brackets, so the send cannot 400", () => {
    const t = text(report({ due: [{ ...laneSilent, evidence: "streak <n> & <url>" }] }));
    expect(t).toContain("streak &lt;n&gt; &amp; &lt;url&gt;");
    expect(t).not.toMatch(/<n>|<url>/);
  });

  it("escapes a failure reason too", () => {
    const t = text(report({ outcome: { state: "failed", reason: 'relation "a<b>" does not exist' }, coverage: null }));
    expect(t).toContain("a&lt;b&gt;");
  });
});

describe("splitting, never truncating (Telegram's 4,096-character limit)", () => {
  it("splits a long list of decisions across messages and loses none of them", () => {
    const many: Finding[] = Array.from({ length: 40 }, (_, i) => ({
      kind: "candidate-not-acting" as const,
      subject: `profile-number-${i}`,
      evidence: `profile-number-${i} has ${20 + i} actionable roles ` + "and a long explanation ".repeat(12),
      severity: "high" as const,
    }));

    const parts = renderJobhuntCheck(report({ due: many }));

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    const joined = parts.join("\n");
    for (let i = 0; i < 40; i++) expect(joined, `row ${i} was hidden`).toContain(`profile-number-${i} has`);
  });

  it("a normal day is one message", () => {
    expect(renderJobhuntCheck(report())).toHaveLength(1);
  });
});

describe("it never names a command the gateway does not have", () => {
  it("every command in a decision or the halt line is registered", () => {
    const gateway = ["telegram.ts", "commands.ts"]
      .map((f) => readFileSync(join(process.cwd(), "src/gateway", f), "utf8"))
      .join("\n");
    const named = new Set<string>();
    const halted = text(report({ outcome: { state: "halted", reason: "x", engagedAt: "y" }, coverage: null }));
    const decisions = text(
      report({
        due: [notActing, laneSilent, { ...notActing, subject: "pushkar-nl-tech" }, { ...laneSilent, subject: "wife-nl-finance" }],
      }),
    );
    for (const t of [halted, decisions]) for (const m of t.matchAll(/(?<![\w<])\/([a-z_]+)/g)) named.add(m[1]!);

    expect([...named].sort()).toEqual(["applied", "jobs", "resume", "today", "wife_applied", "wife_jobs", "wife_today"]);
    for (const name of named) expect(gateway, `/${name} is not registered`).toContain(`command("${name}"`);
  });
});
