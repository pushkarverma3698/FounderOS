import { describe, expect, it } from "vitest";
import { runEvidenceCard, type EvidenceCardDeps } from "../../../scripts/pipeline-evidence-card.js";
import { readContractRecord, writeContractRecord, type ContractRecord } from "../../../src/tools/contract-store.js";
import { claimPending } from "../../../src/tools/pipeline-pending.js";
import { canMerge } from "../../../src/tools/pr-evidence.js";
import { contractFixture, SHA_A, SHA_B } from "../../helpers/contract-fixture.js";
import { memFs, type MemFs } from "../../helpers/mem-fs.js";

const ON = { AGENT_PIPELINE_V2: "1", FOUNDEROS_CONTRACTS_DIR: "/c" };
const REPO = "acme/widgets";
const HEAD = "c".repeat(40);
const BASE = "d".repeat(40);
const CLEARED = "CLEARED — marked ready for merge (self-approval impossible; ready IS the pass) · fix it";
const pass = (mode: string) => ({ status: "PASS", reasons: [], head_sha: mode === "spec" ? SHA_B : HEAD });

const record = (over: Partial<ContractRecord> = {}, contractOver = {}): ContractRecord => ({
  version: 1,
  repo: REPO,
  issue: 7,
  contract: contractFixture({ spec_commit: SHA_B, ...contractOver }),
  fingerprint: "f".repeat(64),
  approved_at: "2026-10-06T00:00:00.000Z",
  approved_by: "founder",
  spec_commit: SHA_B,
  ...over,
});

async function world(rec: ContractRecord | null = record()): Promise<MemFs> {
  const fs = memFs();
  if (rec) {
    const w = await writeContractRecord(fs, "/c", rec);
    if (!w.ok) throw new Error(w.error);
  }
  return fs;
}

interface Seen {
  gh: string[][];
  evidence: string[];
}
function deps(fs: MemFs, over: Partial<EvidenceCardDeps> = {}): { d: EvidenceCardDeps; seen: Seen } {
  const seen: Seen = { gh: [], evidence: [] };
  const d: EvidenceCardDeps = {
    fs,
    nonce: () => "n0nce",
    now: () => new Date("2026-10-06T12:00:00.000Z"),
    async gh(args) {
      seen.gh.push(args);
      const ep = args.find((a) => a.startsWith("repos/")) ?? "";
      if (ep.endsWith("/pulls/9")) return { code: 0, stdout: JSON.stringify({ state: "open", merged: false, html_url: "https://github.com/acme/widgets/pull/9", head: { sha: HEAD }, base: { ref: "beta" } }), stderr: "" };
      if (ep.endsWith("/git/ref/heads/beta")) return { code: 0, stdout: JSON.stringify({ object: { sha: BASE } }), stderr: "" };
      return { code: 1, stdout: "", stderr: "not found" };
    },
    async evidence(mode) {
      seen.evidence.push(mode);
      return pass(mode);
    },
    ...over,
  };
  return { d, seen };
}
const ARGS = ["--repo", REPO, "--issue", "7", "--pr", "9", "--head", HEAD, "--verdict", CLEARED];
const parse = (s: string) => JSON.parse(s) as Record<string, any>;
const buttons = (r: Record<string, any>): string[] => (r.reply_markup.inline_keyboard as Array<Array<{ callback_data?: string }>>).flat().map((b) => b.callback_data ?? "").filter(Boolean);

describe("scripts/pipeline-evidence-card", () => {
  it("flag off: DISABLED, nothing is read and nothing is written", async () => {
    const fs = await world();
    const before = new Map(fs.files);
    for (const env of [{}, { ...ON, AGENT_PIPELINE_V2: "true" }]) {
      const { d, seen } = deps(fs);
      expect(parse(await runEvidenceCard(ARGS, env, d))).toEqual({ status: "DISABLED" });
      expect(seen.gh).toEqual([]);
    }
    expect(fs.files).toEqual(before);
  });

  it("no contract for the issue: NONE (a legacy PR; the caller keeps the old path)", async () => {
    const { d, seen } = deps(await world(null));
    expect(parse(await runEvidenceCard(ARGS, ON, d))).toEqual({ status: "NONE" });
    expect(seen.gh).toEqual([]);
  });

  it("a contract file that cannot be read is INVALID, not NONE (the caller must hold the merge)", async () => {
    const fs = await world(null);
    fs.files.set("/c/acme__widgets__7.json", "{broken");
    const { d } = deps(fs);
    const out = parse(await runEvidenceCard(ARGS, ON, d));
    expect(out.status).toBe("INVALID");
    expect(out.error).toBeTruthy();
  });

  it("all rows PASS and the oracle is unit-only: a card with [I checked it — merge], and a merge record the handler can claim and merge", async () => {
    const fs = await world();
    const { d, seen } = deps(fs);
    const out = parse(await runEvidenceCard(ARGS, ON, d));
    expect(out.status).toBe("CARD");
    expect(out.nonce).toBe("n0nce");
    expect(seen.evidence).toEqual(["spec", "green"]);
    expect(buttons(out)).toContain("cp:merge_ack:n0nce");
    expect(buttons(out)).not.toContain("cp:merge:n0nce");
    expect(out.parts.join("\n")).toMatch(/unit-only/);

    const claimed = await claimPending(fs, "/c", "n0nce");
    expect(claimed.ok).toBe(true);
    if (!claimed.ok || claimed.value.kind !== "merge") throw new Error("expected a merge record");
    const m = claimed.value;
    expect(m).toMatchObject({ repo: REPO, issue: 7, pr: 9, head_at_review: HEAD, base_at_review: BASE });
    expect(m.evidence).toEqual({ status: "PASS", reasons: [], head_sha: HEAD });
    expect(m.review).toEqual({ decision: "APPROVE", head_sha: HEAD });
    // The same facts at tap time: the gate the handler runs agrees.
    expect(canMerge({ evidence: m.evidence, review: m.review, headAtReview: m.head_at_review, headNow: HEAD, baseAtReview: m.base_at_review, baseNow: BASE }).ok).toBe(true);
    // And the handler's own moved-head refusal fires if the head moves after the card.
    expect(canMerge({ evidence: m.evidence, review: m.review, headAtReview: m.head_at_review, headNow: "e".repeat(40), baseAtReview: m.base_at_review, baseNow: BASE }).ok).toBe(false);
  });

  it("binds the contract to the PR (set once)", async () => {
    const fs = await world();
    await runEvidenceCard(ARGS, ON, deps(fs).d);
    const r = await readContractRecord(fs, "/c", REPO, 7);
    expect(r.ok && r.value.pr).toBe(9);
  });

  it("an http oracle has nothing unverified, so the plain [Merge] button", async () => {
    const fs = await world(record({}, { oracle: { id: "o2", kind: "http", target: "https://x.test/h", before: {}, expected_after: {} } }));
    const out = parse(await runEvidenceCard(ARGS, ON, deps(fs).d));
    expect(buttons(out)).toEqual(["cp:merge:n0nce"]);
  });

  it("a review that is not an approval: the card says so, has no merge button, and no merge record is written", async () => {
    const fs = await world();
    const args = [...ARGS.slice(0, -1), "REVIEWED, left as draft — not cleared · fix it"];
    const out = parse(await runEvidenceCard(args, ON, deps(fs).d));
    expect(out.status).toBe("CARD");
    expect(buttons(out)).toEqual([]);
    expect(out.parts.join("\n")).toMatch(/Review: \? UNKNOWN/);
    expect([...fs.files.keys()].some((k) => k.startsWith("/c/pending/"))).toBe(false);
  });

  it("green evidence FAIL: its reasons are on the card, no merge button, no merge record", async () => {
    const fs = await world();
    const { d } = deps(fs, { evidence: async (mode) => (mode === "green" ? { status: "FAIL", reasons: ["locked test edited: tests/unit/tools/oracle.test.ts"], head_sha: HEAD } : pass(mode)) });
    const out = parse(await runEvidenceCard(ARGS, ON, d));
    expect(buttons(out)).toEqual([]);
    expect(out.parts.join("\n")).toContain("locked test edited");
    expect([...fs.files.keys()].some((k) => k.startsWith("/c/pending/"))).toBe(false);
  });

  it("an evidence run that throws is UNKNOWN on the card, never a pass", async () => {
    const fs = await world();
    const { d } = deps(fs, { evidence: async () => { throw new Error("gh exploded"); } });
    const out = parse(await runEvidenceCard(ARGS, ON, d));
    expect(out.status).toBe("CARD");
    expect(buttons(out)).toEqual([]);
    expect(out.parts.join("\n")).toMatch(/UNKNOWN/);
    expect(out.parts.join("\n")).toContain("gh exploded");
  });

  it("the head moved while the review ran: FAILED, nothing written, no card", async () => {
    const fs = await world();
    const before = new Map(fs.files);
    const args = ARGS.map((a) => (a === HEAD ? "e".repeat(40) : a));
    const out = parse(await runEvidenceCard(args, ON, deps(fs).d));
    expect(out.status).toBe("FAILED");
    expect(out.error).toMatch(/head/);
    expect(fs.files).toEqual(before);
  });

  it("a contract already bound to another PR: FAILED", async () => {
    const fs = await world(record({ pr: 12 }));
    const out = parse(await runEvidenceCard(ARGS, ON, deps(fs).d));
    expect(out.status).toBe("FAILED");
    expect(out.error).toMatch(/12/);
  });

  it("GitHub unreadable: FAILED, nothing written", async () => {
    const fs = await world();
    const before = new Map(fs.files);
    const { d } = deps(fs, { gh: async () => ({ code: 1, stdout: "", stderr: "HTTP 502" }) });
    const out = parse(await runEvidenceCard(ARGS, ON, d));
    expect(out.status).toBe("FAILED");
    expect(fs.files).toEqual(before);
  });

  it("a PR that is not open: FAILED", async () => {
    const fs = await world();
    const { d } = deps(fs, {
      gh: async (a) => ({ code: 0, stdout: JSON.stringify(a.some((x) => x.endsWith("/pulls/9")) ? { state: "closed", merged: false, html_url: "https://github.com/acme/widgets/pull/9", head: { sha: HEAD }, base: { ref: "beta" } } : { object: { sha: BASE } }), stderr: "" }),
    });
    expect(parse(await runEvidenceCard(ARGS, ON, d)).status).toBe("FAILED");
  });

  it("bad arguments: FAILED with the usage, never a crash", async () => {
    const { d } = deps(await world());
    for (const args of [[], ["--repo", REPO], [...ARGS, "--bogus", "x"], ARGS.map((a) => (a === "9" ? "nine" : a)), ARGS.map((a) => (a === HEAD ? "abc" : a))]) {
      expect(parse(await runEvidenceCard(args, ON, d)).status).toBe("FAILED");
    }
  });

  it("the verdict text may contain anything: it is only matched, never run or printed raw", async () => {
    const fs = await world();
    const args = [...ARGS.slice(0, -1), "CLEARED \"; rm -r -f / #<b>"];
    const out = parse(await runEvidenceCard(args, ON, deps(fs).d));
    expect(out.status).toBe("CARD");
    expect(out.parts.join("\n")).not.toContain("rm -r");
  });
});
