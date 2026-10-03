/** Pure pieces of golden journey A (30-day plan): an agent:ready issue ends in a PR whose CI is green. */
import { AGENT_BRIEF_HEADINGS } from "../../src/tools/agent-brief-parse.js";

export interface JourneyAState {
  /** Head branch of the open PR for the issue, if one appeared. */
  prBranch: string | undefined;
  /** Conclusions of the latest check runs on that PR's head; null = still running. */
  checks: (string | null)[];
  /** agent:* labels now on the issue. */
  labels: string[];
  waitedMin: number;
  limitMin: number;
}

export interface JourneyAVerdict {
  /** done = stop polling; ok only meaningful when done. */
  done: boolean;
  ok: boolean;
  detail: string;
}

export function judgeCoding(s: JourneyAState): JourneyAVerdict {
  const failed = s.labels.find((l) => l === "agent:failed" || l === "agent:blocked" || l === "agent:needs-brief");
  if (!s.prBranch && failed) return { done: true, ok: false, detail: `issue went to ${failed} with no PR after ${s.waitedMin} min` };
  if (s.prBranch) {
    const bad = s.checks.filter((c) => c !== null && !["success", "skipped", "neutral"].includes(c));
    if (bad.length > 0) return { done: true, ok: false, detail: `PR ${s.prBranch} opened but CI is ${bad[0]}` };
    if (s.checks.length > 0 && s.checks.every((c) => c !== null)) {
      return { done: true, ok: true, detail: `PR ${s.prBranch} opened in ${s.waitedMin} min with green CI` };
    }
  }
  if (s.waitedMin >= s.limitMin) {
    return {
      done: true,
      ok: false,
      detail: s.prBranch ? `PR ${s.prBranch} still had no finished CI after ${s.limitMin} min` : `no PR after ${s.limitMin} min (labels: ${s.labels.join(", ") || "none"})`,
    };
  }
  return { done: false, ok: false, detail: "waiting" };
}

/** A complete nine-section brief for the sandbox repo's trivial standing task. */
export function sandboxBrief(stamp: string): string {
  const body: Record<(typeof AGENT_BRIEF_HEADINGS)[number], string> = {
    "Goal": `Append one line to NOTES.md recording journey run ${stamp}.`,
    "Problem / observed behavior": "NOTES.md has no line for this run. This is a standing smoke task, not a real bug.",
    "Expected behavior": `NOTES.md ends with the line \`- journey ${stamp}\`.`,
    "Evidence": "Run `cat NOTES.md`: the line is absent.",
    "Files or subsystem in scope": "`NOTES.md`",
    "Constraints": "Change NOTES.md only. Keep its first heading `# Notes`.",
    "Explicitly forbidden": "Do not touch `.github/` or add files.",
    "Verification commands": "`test -s NOTES.md && grep -q '^# Notes' NOTES.md && tail -1 NOTES.md`",
    "Acceptance criteria": "The last line of NOTES.md is exactly the line above and CI is green.",
  };
  return AGENT_BRIEF_HEADINGS.map((h) => `## ${h}\n${body[h]}`).join("\n\n");
}
