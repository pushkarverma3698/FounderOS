import { describe, expect, it } from "vitest";
import { runEvidenceCard, type EvidenceCardDeps } from "../../../scripts/pipeline-evidence-card.js";
import { claimPending } from "../../../src/tools/pipeline-pending.js";
import { canMerge } from "../../../src/tools/pr-evidence.js";
import { memFs, type MemFs } from "../../helpers/mem-fs.js";

// AG-062: no flag and no contract. A cleared job PR gets a merge card built from its required CI and the review.
const ENV = { FOUNDEROS_CONTRACTS_DIR: "/c" };
const REPO = "acme/widgets";
const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);
const CLEARED = "CLEARED — marked ready for merge (self-approval impossible; ready IS the pass) · fix it";
const GREEN = JSON.stringify([
  { bucket: "pass", name: "gate" },
  { bucket: "skipping", name: "ui-qa" },
]);

interface Seen {
  gh: string[][];
}
function deps(fs: MemFs, over: Partial<EvidenceCardDeps> = {}, checks: { code: number; stdout: string; stderr: string } = { code: 0, stdout: GREEN, stderr: "" }): { d: EvidenceCardDeps; seen: Seen } {
  const seen: Seen = { gh: [] };
  const d: EvidenceCardDeps = {
    fs,
    nonce: () => "n0nce",
    now: () => new Date("2026-10-06T12:00:00.000Z"),
    async gh(args) {
      seen.gh.push(args);
      if (args[0] === "pr" && args[1] === "checks") return checks;
      const ep = args.find((a) => a.startsWith("repos/")) ?? "";
      if (ep.endsWith("/pulls/9")) return { code: 0, stdout: JSON.stringify({ state: "open", title: "Fix the thing", html_url: "https://github.com/acme/widgets/pull/9", head: { sha: HEAD }, base: { ref: "beta" } }), stderr: "" };
      if (ep.endsWith("/git/ref/heads/beta")) return { code: 0, stdout: JSON.stringify({ object: { sha: BASE } }), stderr: "" };
      return { code: 1, stdout: "", stderr: "not found" };
    },
    ...over,
  };
  return { d, seen };
}
const ARGS = ["--repo", REPO, "--issue", "7", "--pr", "9", "--head", HEAD, "--verdict", CLEARED];
const parse = (s: string) => JSON.parse(s) as Record<string, any>;
const buttons = (r: Record<string, any>): string[] => (r.reply_markup.inline_keyboard as Array<Array<{ callback_data?: string }>>).flat().map((b) => b.callback_data ?? "").filter(Boolean);
const pendingFiles = (fs: MemFs): string[] => [...fs.files.keys()].filter((k) => k.startsWith("/c/pending/"));

describe("scripts/pipeline-evidence-card", () => {
  it("required CI green and the review cleared: a card with [Merge], and a merge record the handler can claim", async () => {
    const fs = memFs();
    const { d, seen } = deps(fs);
    const out = parse(await runEvidenceCard(ARGS, ENV, d));
    expect(out.status).toBe("CARD");
    expect(out.mergeable).toBe(true);
    expect(buttons(out)).toEqual(["cp:merge:n0nce"]);
    expect(out.parts.join("\n")).toContain("issue #7");
    expect(seen.gh).toContainEqual(["pr", "checks", "9", "--repo", REPO, "--required", "--json", "bucket,name"]);

    const claimed = await claimPending(fs, "/c", "n0nce");
    if (!claimed.ok || claimed.value.kind !== "merge") throw new Error("expected a merge record");
    const m = claimed.value;
    expect(m).toMatchObject({ repo: REPO, issue: 7, pr: 9, head_at_review: HEAD, base_at_review: BASE });
    expect(m.evidence).toEqual({ status: "PASS", reasons: [], head_sha: HEAD });
    expect(m.review).toEqual({ decision: "APPROVE", head_sha: HEAD });
    expect(canMerge({ evidence: m.evidence, review: m.review, headAtReview: m.head_at_review, headNow: HEAD, baseAtReview: m.base_at_review, baseNow: BASE }).ok).toBe(true);
    expect(canMerge({ evidence: m.evidence, review: m.review, headAtReview: m.head_at_review, headNow: "e".repeat(40), baseAtReview: m.base_at_review, baseNow: BASE }).ok).toBe(false);
  });

  it("an AGENT_PIPELINE_V2 in the env changes nothing: there is no flag", async () => {
    const fs = memFs();
    const out = parse(await runEvidenceCard(ARGS, { ...ENV, AGENT_PIPELINE_V2: "0" }, deps(fs).d));
    expect(out.status).toBe("CARD");
    expect(buttons(out)).toEqual(["cp:merge:n0nce"]);
  });

  it("a review that is not an approval: NONE, GitHub is not read and nothing is written", async () => {
    const fs = memFs();
    const { d, seen } = deps(fs);
    const out = parse(await runEvidenceCard([...ARGS.slice(0, -1), "REVIEWED, left as draft — not cleared · fix it"], ENV, d));
    expect(out.status).toBe("NONE");
    expect(seen.gh).toEqual([]);
    expect(fs.files.size).toBe(0);
  });

  it("a required check failed: its name is on the card, no merge button, no merge record", async () => {
    const fs = memFs();
    const { d } = deps(fs, {}, { code: 1, stdout: JSON.stringify([{ bucket: "fail", name: "gate" }, { bucket: "pass", name: "lint" }]), stderr: "" });
    const out = parse(await runEvidenceCard(ARGS, ENV, d));
    expect(out.status).toBe("CARD");
    expect(buttons(out)).toEqual([]);
    expect(out.parts.join("\n")).toContain("required check failed: gate");
    expect(pendingFiles(fs)).toEqual([]);
  });

  it("required checks still running, or none configured: UNKNOWN on the card, never a merge button", async () => {
    for (const checks of [
      { code: 8, stdout: JSON.stringify([{ bucket: "pending", name: "gate" }]), stderr: "" },
      { code: 1, stdout: "", stderr: "no required checks reported on the 'task/issue-7' branch" },
    ]) {
      const fs = memFs();
      const out = parse(await runEvidenceCard(ARGS, ENV, deps(fs, {}, checks).d));
      expect(out.status).toBe("CARD");
      expect(buttons(out)).toEqual([]);
      expect(out.parts.join("\n")).toMatch(/UNKNOWN/);
      expect(pendingFiles(fs)).toEqual([]);
    }
  });

  it("the head moved while the review ran: FAILED, nothing written, no card", async () => {
    const fs = memFs();
    const args = ARGS.map((a) => (a === HEAD ? "e".repeat(40) : a));
    const out = parse(await runEvidenceCard(args, ENV, deps(fs).d));
    expect(out.status).toBe("FAILED");
    expect(out.error).toMatch(/head/);
    expect(fs.files.size).toBe(0);
  });

  it("GitHub unreadable: FAILED, nothing written", async () => {
    const fs = memFs();
    const { d } = deps(fs, { gh: async () => ({ code: 1, stdout: "", stderr: "HTTP 502" }) });
    expect(parse(await runEvidenceCard(ARGS, ENV, d)).status).toBe("FAILED");
    expect(fs.files.size).toBe(0);
  });

  it("a PR that is not open: FAILED", async () => {
    const fs = memFs();
    const { d } = deps(fs, {
      gh: async (a) => ({ code: 0, stdout: JSON.stringify(a.some((x) => x.endsWith("/pulls/9")) ? { state: "closed", html_url: "https://github.com/acme/widgets/pull/9", head: { sha: HEAD }, base: { ref: "beta" } } : { object: { sha: BASE } }), stderr: "" }),
    });
    expect(parse(await runEvidenceCard(ARGS, ENV, d)).status).toBe("FAILED");
  });

  it("bad arguments: FAILED with the usage, never a crash", async () => {
    const { d } = deps(memFs());
    for (const args of [[], ["--repo", REPO], [...ARGS, "--bogus", "x"], ARGS.map((a) => (a === "9" ? "nine" : a)), ARGS.map((a) => (a === HEAD ? "abc" : a))]) {
      expect(parse(await runEvidenceCard(args, ENV, d)).status).toBe("FAILED");
    }
  });

  it("the verdict text may contain anything: it is only matched, never run or printed raw", async () => {
    const args = [...ARGS.slice(0, -1), "CLEARED \"; rm -r -f / #<b>"];
    const out = parse(await runEvidenceCard(args, ENV, deps(memFs()).d));
    expect(out.status).toBe("CARD");
    expect(out.parts.join("\n")).not.toContain("rm -r");
  });
});
