/**
 * The cp: buttons: Approve / Change / Cancel under the spec card, Merge / Merge-after-checking under the evidence card.
 * Every test drives the real handler with a real pending store on an in-memory fs; only GitHub and the audit table are fakes.
 * What is asserted is what the founder sees and what reached GitHub, the contract store and the audit log.
 */
import { describe, it, expect, vi } from "vitest";
import type { Context } from "grammy";
import { handleCodingCallback, type CodingDeps, type PrState } from "../../../src/gateway/coding-callbacks.js";
import { fingerprintOf } from "../../../src/tools/spec-gate.js";
import { readContractRecord, writeContractRecord } from "../../../src/tools/contract-store.js";
import {
  claimPending,
  readPending,
  writePending,
  type PendingMerge,
  type PendingSpec,
} from "../../../src/tools/pipeline-pending.js";
import { SHA_A, SHA_B, contractFixture } from "../../helpers/contract-fixture.js";
import { memFs } from "../../helpers/mem-fs.js";

const REPO = "pushkarverma3698/fos-journey-sandbox";
const DIR = "/store";
const NOW = new Date("2026-10-06T10:30:00.000Z");
const SPEC_NONCE = "specNonce1";
const MERGE_NONCE = "mergeNonce1";
const MERGE_SHA = "c".repeat(40);
const HEAD = SHA_B;
const BASE = SHA_A;

const contract = () => contractFixture({ repo: REPO, spec_commit: SHA_B });

function specRecord(over: Partial<PendingSpec> = {}): PendingSpec {
  const c = contract();
  return {
    kind: "spec",
    nonce: SPEC_NONCE,
    repo: REPO,
    issue: 12,
    contract: c,
    effective_risk: "low",
    fingerprint: fingerprintOf(c),
    spec_commit: SHA_B,
    created_at: "2026-10-06T10:00:00.000Z",
    ...over,
  };
}

function mergeRecord(over: Partial<PendingMerge> = {}): PendingMerge {
  return {
    kind: "merge",
    nonce: MERGE_NONCE,
    repo: REPO,
    issue: 12,
    pr: 40,
    evidence: { status: "PASS", reasons: [], head_sha: HEAD },
    review: { decision: "APPROVE", head_sha: HEAD },
    head_at_review: HEAD,
    base_at_review: BASE,
    created_at: "2026-10-06T10:00:00.000Z",
    ...over,
  };
}

interface Harness {
  deps: CodingDeps;
  fs: ReturnType<typeof memFs>;
  labels: Array<{ repo: string; issue: number; add: readonly string[]; remove: readonly string[] }>;
  comments: string[];
  merges: Array<{ repo: string; pr: number; sha: string }>;
  audits: Array<{ action: string; key: string; payload: Record<string, unknown> }>;
  audited: Set<string>;
  jobs: Array<{ repo: string; issue: number; stage: string }>;
  jobResult: { status: "inert" | "started" } | { status: "failed"; reason: string };
  pr: PrState;
}

function harness(over: { env?: Record<string, string>; pr?: Partial<PrState> } = {}): Harness {
  const fs = memFs();
  const h: Harness = {
    fs,
    labels: [],
    comments: [],
    merges: [],
    audits: [],
    audited: new Set(),
    jobs: [],
    jobResult: { status: "started" },
    pr: { state: "open", merged: false, headSha: HEAD, baseSha: BASE, baseRef: "beta", ...over.pr },
    deps: undefined as unknown as CodingDeps,
  };
  h.deps = {
    env: { AGENT_PIPELINE_V2: "1", ...over.env },
    fs,
    dir: DIR,
    now: () => NOW,
    async setLabels(repo, issue, change) {
      h.labels.push({ repo, issue, add: change.add, remove: change.remove });
    },
    async comment(_repo, _issue, body) {
      h.comments.push(body);
    },
    async startJob(repo, issue, stage) {
      h.jobs.push({ repo, issue, stage });
      return h.jobResult;
    },
    async inspectPr() {
      return h.pr;
    },
    async merge(repo, pr, sha) {
      h.merges.push({ repo, pr, sha });
      return MERGE_SHA;
    },
    async alreadyDone(key) {
      return h.audited.has(key);
    },
    async audit(row) {
      h.audits.push(row);
      h.audited.add(row.key);
      return true;
    },
  };
  return h;
}

function ctxFor(data: string) {
  const answer = vi.fn(async () => true);
  const reply = vi.fn(async () => ({}));
  const clear = vi.fn(async () => true);
  const ctx = {
    callbackQuery: { data },
    answerCallbackQuery: answer,
    reply,
    editMessageReplyMarkup: clear,
  } as unknown as Context;
  const said = () => reply.mock.calls.map((c) => String((c as unknown[])[0])).join("\n");
  return { ctx, answer, reply, clear, said };
}

const tap = (h: Harness, action: string, nonce: string) => {
  const c = ctxFor(`cp:${action}:${nonce}`);
  return handleCodingCallback(c.ctx, h.deps).then((handled) => ({ handled, ...c }));
};

async function seed(h: Harness, rec: PendingSpec | PendingMerge): Promise<void> {
  const w = await writePending(h.fs, DIR, rec);
  expect(w.ok).toBe(true);
}

async function seedApproved(h: Harness, extra: { pr?: number } = {}): Promise<void> {
  const c = contract();
  const w = await writeContractRecord(h.fs, DIR, {
    version: 1,
    repo: REPO,
    issue: 12,
    contract: c,
    fingerprint: fingerprintOf(c),
    approved_at: "2026-10-06T10:10:00.000Z",
    approved_by: "founder",
    spec_commit: SHA_B,
    ...extra,
  });
  expect(w.ok).toBe(true);
}

describe("not ours / switched off", () => {
  it("returns false for a payload that is not cp:, so the next handler gets it", async () => {
    const h = harness();
    const c = ctxFor("md:approve:1");
    expect(await handleCodingCallback(c.ctx, h.deps)).toBe(false);
    expect(c.answer).not.toHaveBeenCalled();
  });

  it("answers a malformed cp: payload as out of date and touches nothing", async () => {
    const h = harness();
    const r = await tap(h, "explode", SPEC_NONCE);
    expect(r.handled).toBe(true);
    expect(JSON.stringify(r.answer.mock.calls)).toContain("out of date");
    expect(h.labels).toEqual([]);
  });

  it("is a no-op with the flag off: the card stays valid and nothing is written", async () => {
    const h = harness({ env: { AGENT_PIPELINE_V2: "true" } });
    await seed(h, specRecord());
    const r = await tap(h, "approve", SPEC_NONCE);
    expect(r.handled).toBe(true);
    expect(r.said() + JSON.stringify(r.answer.mock.calls)).toMatch(/switched off/i);
    expect(h.labels).toEqual([]);
    expect((await readPending(h.fs, DIR, SPEC_NONCE)).ok).toBe(true);
    expect((await readContractRecord(h.fs, DIR, REPO, 12)).ok).toBe(false);
  });
});

describe("approve", () => {
  it("stores the contract as founder-approved, labels agent:ready, audits, and tells the founder", async () => {
    const h = harness();
    await seed(h, specRecord());
    const r = await tap(h, "approve", SPEC_NONCE);

    const stored = await readContractRecord(h.fs, DIR, REPO, 12);
    expect(stored.ok && stored.value.approved_by).toBe("founder");
    expect(stored.ok && stored.value.approved_at).toBe(NOW.toISOString());
    expect(stored.ok && stored.value.spec_commit).toBe(SHA_B);
    expect(stored.ok && stored.value.fingerprint).toBe(fingerprintOf(contract()));
    expect(h.labels).toEqual([{ repo: REPO, issue: 12, add: ["agent:ready"], remove: ["agent:spec-review"] }]);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]?.key).toBe(`pipeline_spec_approved:${REPO}#12:${fingerprintOf(contract())}`);
    expect(h.comments.join("\n")).toContain(fingerprintOf(contract()).slice(0, 12));
    expect(r.said()).toMatch(/approved/i);
    expect(r.clear).toHaveBeenCalled();
    // the pending record is spent
    expect((await readPending(h.fs, DIR, SPEC_NONCE)).ok).toBe(false);
  });

  it("starts the build run for the approved issue (stage=build)", async () => {
    const h = harness();
    await seed(h, specRecord());
    const r = await tap(h, "approve", SPEC_NONCE);
    expect(h.jobs).toEqual([{ repo: REPO, issue: 12, stage: "build" }]);
    expect(r.said()).not.toMatch(/did not start/);
  });

  it("when the run cannot start the founder is told in the same chat, and the approval stands", async () => {
    const h = harness();
    h.jobResult = { status: "failed", reason: "connect ENOENT /run/fos-job.sock" };
    await seed(h, specRecord());
    const r = await tap(h, "approve", SPEC_NONCE);
    expect(r.said()).toContain("The build did not start: connect ENOENT /run/fos-job.sock");
    expect(h.labels).toHaveLength(1);
    expect((await readPending(h.fs, DIR, SPEC_NONCE)).ok).toBe(false);
  });

  it("a second tap of the same card does nothing: one label change, one audit row", async () => {
    const h = harness();
    await seed(h, specRecord());
    await tap(h, "approve", SPEC_NONCE);
    const again = await tap(h, "approve", SPEC_NONCE);
    expect(h.labels).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
    expect(again.said() + JSON.stringify(again.answer.mock.calls)).toMatch(/already used|expired/i);
  });

  it("two simultaneous taps approve once", async () => {
    const h = harness();
    await seed(h, specRecord());
    await Promise.all([tap(h, "approve", SPEC_NONCE), tap(h, "approve", SPEC_NONCE)]);
    expect(h.labels).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  it("refuses a record whose contract no longer matches its fingerprint (tampered or edited)", async () => {
    const h = harness();
    const tampered = specRecord({ contract: { ...contract(), scope: ["src/**"] } });
    await seed(h, tampered);
    const r = await tap(h, "approve", SPEC_NONCE);
    expect(r.said()).toMatch(/fingerprint/i);
    expect(h.labels).toEqual([]);
    expect((await readContractRecord(h.fs, DIR, REPO, 12)).ok).toBe(false);
  });

  it("refuses a repo that is not on the dispatch allowlist, before writing anything", async () => {
    const h = harness();
    const c = contractFixture({ repo: "evil/repo", spec_commit: SHA_B });
    await seed(h, specRecord({ repo: "evil/repo", contract: c, fingerprint: fingerprintOf(c) }));
    const r = await tap(h, "approve", SPEC_NONCE);
    expect(r.said()).toMatch(/allowlist|not a repository/i);
    expect(h.labels).toEqual([]);
    expect((await readContractRecord(h.fs, DIR, "evil/repo", 12)).ok).toBe(false);
  });

  it("refuses when the issue already has a DIFFERENT approved contract, and says so", async () => {
    const h = harness();
    const other = contractFixture({ repo: REPO, spec_commit: SHA_B, scope: ["src/other.ts"] });
    await writeContractRecord(h.fs, DIR, {
      version: 1,
      repo: REPO,
      issue: 12,
      contract: other,
      fingerprint: fingerprintOf(other),
      approved_at: "2026-10-06T09:00:00.000Z",
      approved_by: "founder",
      spec_commit: SHA_B,
    });
    await seed(h, specRecord());
    const r = await tap(h, "approve", SPEC_NONCE);
    expect(r.said()).toMatch(/different|already/i);
    expect(h.labels).toEqual([]);
  });

  it("a label failure keeps the approval, releases the card, and a retry finishes without a second record", async () => {
    const h = harness();
    await seed(h, specRecord());
    let fail = true;
    const real = h.deps.setLabels;
    h.deps.setLabels = async (...a) => {
      if (fail) throw new Error("GitHub 502");
      return real(...a);
    };
    const first = await tap(h, "approve", SPEC_NONCE);
    expect(first.said()).toMatch(/GitHub 502/);
    expect(first.said()).toMatch(/tap Approve again|again/i);
    expect((await readContractRecord(h.fs, DIR, REPO, 12)).ok).toBe(true);
    expect((await readPending(h.fs, DIR, SPEC_NONCE)).ok).toBe(true);
    expect(first.clear).not.toHaveBeenCalled();

    fail = false;
    const second = await tap(h, "approve", SPEC_NONCE);
    expect(second.said()).toMatch(/approved/i);
    expect(h.labels).toHaveLength(1);
    expect(h.audits).toHaveLength(1);
  });

  it("a merge-kind record under an approve button is refused and left claimable", async () => {
    const h = harness();
    await seed(h, mergeRecord({ nonce: SPEC_NONCE }));
    const r = await tap(h, "approve", SPEC_NONCE);
    expect(r.said()).toMatch(/not a spec/i);
    expect(h.labels).toEqual([]);
    expect((await readPending(h.fs, DIR, SPEC_NONCE)).ok).toBe(true);
  });

  it("an unknown nonce says the card was used or expired", async () => {
    const h = harness();
    const r = await tap(h, "approve", "nope");
    expect(r.said() + JSON.stringify(r.answer.mock.calls)).toMatch(/already used|expired/i);
    expect(h.labels).toEqual([]);
  });
});

describe("change and cancel", () => {
  it("change moves the issue to agent:needs-brief and says how to resubmit", async () => {
    const h = harness();
    await seed(h, specRecord());
    const r = await tap(h, "change", SPEC_NONCE);
    expect(h.labels).toEqual([{ repo: REPO, issue: 12, add: ["agent:needs-brief"], remove: ["agent:spec-review"] }]);
    expect(r.said()).toMatch(/agent:spec/);
    expect((await readContractRecord(h.fs, DIR, REPO, 12)).ok).toBe(false);
    expect((await readPending(h.fs, DIR, SPEC_NONCE)).ok).toBe(false);
  });

  it("cancel drops the review label, does not close the issue, and approves nothing", async () => {
    const h = harness();
    await seed(h, specRecord());
    const r = await tap(h, "cancel", SPEC_NONCE);
    expect(h.labels).toEqual([{ repo: REPO, issue: 12, add: [], remove: ["agent:spec-review"] }]);
    expect(r.said()).toMatch(/cancel/i);
    expect((await readContractRecord(h.fs, DIR, REPO, 12)).ok).toBe(false);
    expect(h.audits).toEqual([]);
  });
});

describe("merge", () => {
  it("merges the exact reviewed head, audits after success, and records pr + merged_sha for the oracle", async () => {
    const h = harness();
    await seedApproved(h);
    await seed(h, mergeRecord());
    const r = await tap(h, "merge", MERGE_NONCE);

    expect(h.merges).toEqual([{ repo: REPO, pr: 40, sha: HEAD }]);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]?.action).toBe("pipeline_merge");
    expect(h.audits[0]?.key).toBe(`merge:${REPO}#40@${HEAD}`);
    expect(h.audits[0]?.payload["acknowledged_unverified"]).toBe(false);
    const stored = await readContractRecord(h.fs, DIR, REPO, 12);
    expect(stored.ok && stored.value.pr).toBe(40);
    expect(stored.ok && stored.value.merged_sha).toBe(MERGE_SHA);
    expect(r.said()).toMatch(/merged/i);
    expect(r.clear).toHaveBeenCalled();
  });

  it("merge_ack records that the founder acknowledged unverified items", async () => {
    const h = harness();
    await seedApproved(h);
    await seed(h, mergeRecord());
    await tap(h, "merge_ack", MERGE_NONCE);
    expect(h.audits[0]?.payload["acknowledged_unverified"]).toBe(true);
    expect(h.merges).toHaveLength(1);
  });

  it("refuses when the head moved since review, prints the reason, and merges nothing", async () => {
    const h = harness({ pr: { headSha: "d".repeat(40) } });
    await seedApproved(h);
    await seed(h, mergeRecord());
    const r = await tap(h, "merge", MERGE_NONCE);
    expect(h.merges).toEqual([]);
    expect(h.audits).toEqual([]);
    expect(r.said()).toMatch(/head moved/i);
  });

  it("refuses when the base moved since review", async () => {
    const h = harness({ pr: { baseSha: "e".repeat(40) } });
    await seedApproved(h);
    await seed(h, mergeRecord());
    const r = await tap(h, "merge", MERGE_NONCE);
    expect(h.merges).toEqual([]);
    expect(r.said()).toMatch(/base moved/i);
  });

  it("refuses non-PASS evidence and non-APPROVE review even if the button somehow exists", async () => {
    for (const rec of [
      mergeRecord({ evidence: { status: "UNKNOWN", reasons: ["no CI run"], head_sha: HEAD } }),
      mergeRecord({ review: { decision: "REQUEST_CHANGES", head_sha: HEAD } }),
    ]) {
      const h = harness();
      await seedApproved(h);
      await seed(h, rec);
      const r = await tap(h, "merge", MERGE_NONCE);
      expect(h.merges).toEqual([]);
      expect(r.said()).toMatch(/evidence is UNKNOWN|not APPROVE/);
    }
  });

  it("fails closed when the issue has no approved contract", async () => {
    const h = harness();
    await seed(h, mergeRecord());
    const r = await tap(h, "merge", MERGE_NONCE);
    expect(h.merges).toEqual([]);
    expect(r.said()).toMatch(/no approved contract/i);
  });

  it("refuses a PR the stored contract is bound to a different number for", async () => {
    const h = harness();
    await seedApproved(h, { pr: 41 });
    await seed(h, mergeRecord());
    const r = await tap(h, "merge", MERGE_NONCE);
    expect(h.merges).toEqual([]);
    expect(r.said()).toMatch(/#41/);
  });

  it("an already-merged PR is reported, not merged again", async () => {
    const h = harness({ pr: { state: "closed", merged: true } });
    await seedApproved(h);
    await seed(h, mergeRecord());
    const r = await tap(h, "merge", MERGE_NONCE);
    expect(h.merges).toEqual([]);
    expect(r.said()).toMatch(/already merged/i);
  });

  it("a PR closed without merging is reported, not merged", async () => {
    const h = harness({ pr: { state: "closed", merged: false } });
    await seedApproved(h);
    await seed(h, mergeRecord());
    const r = await tap(h, "merge", MERGE_NONCE);
    expect(h.merges).toEqual([]);
    expect(r.said()).toMatch(/closed/i);
  });

  it("an audit row from an earlier merge of this head blocks a second merge", async () => {
    const h = harness();
    await seedApproved(h);
    await seed(h, mergeRecord());
    h.audited.add(`merge:${REPO}#40@${HEAD}`);
    const r = await tap(h, "merge", MERGE_NONCE);
    expect(h.merges).toEqual([]);
    expect(r.said()).toMatch(/already (merged|audited|recorded)/i);
  });

  it("a GitHub read error releases the card so the founder can tap again", async () => {
    const h = harness();
    await seedApproved(h);
    await seed(h, mergeRecord());
    h.deps.inspectPr = async () => {
      throw new Error("timeout");
    };
    const r = await tap(h, "merge", MERGE_NONCE);
    expect(r.said()).toMatch(/timeout/);
    expect(h.merges).toEqual([]);
    expect((await readPending(h.fs, DIR, MERGE_NONCE)).ok).toBe(true);
  });

  it("GitHub refusing the merge writes no audit row, releases the card, and says nothing was merged", async () => {
    const h = harness();
    await seedApproved(h);
    await seed(h, mergeRecord());
    h.deps.merge = async () => {
      throw new Error("Required status check is failing");
    };
    const r = await tap(h, "merge", MERGE_NONCE);
    expect(r.said()).toMatch(/Required status check/);
    expect(r.said()).toMatch(/nothing was merged/i);
    expect(h.audits).toEqual([]);
    expect((await readPending(h.fs, DIR, MERGE_NONCE)).ok).toBe(true);
  });

  it("if recording merged_sha fails after the merge, the founder is told the merge happened and the oracle cannot find it", async () => {
    const h = harness();
    await seedApproved(h);
    await seed(h, mergeRecord());
    h.deps.merge = async () => "not-a-sha";
    const r = await tap(h, "merge", MERGE_NONCE);
    expect(r.said()).toMatch(/merged/i);
    expect(r.said()).toMatch(/oracle|post-deploy/i);
    expect(h.audits).toHaveLength(1);
  });

  it("two simultaneous merge taps merge once", async () => {
    const h = harness();
    await seedApproved(h);
    await seed(h, mergeRecord());
    await Promise.all([tap(h, "merge", MERGE_NONCE), tap(h, "merge", MERGE_NONCE)]);
    expect(h.merges).toHaveLength(1);
  });

  it("a spec-kind record under a merge button is refused and left claimable", async () => {
    const h = harness();
    await seedApproved(h);
    await seed(h, specRecord({ nonce: MERGE_NONCE }));
    const r = await tap(h, "merge", MERGE_NONCE);
    expect(h.merges).toEqual([]);
    expect(r.said()).toMatch(/not a merge/i);
    expect((await claimPending(h.fs, DIR, MERGE_NONCE)).ok).toBe(true);
  });
});
