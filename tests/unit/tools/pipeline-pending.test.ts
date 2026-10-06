import { describe, it, expect } from "vitest";
import {
  LABEL_READY,
  LABEL_SPEC,
  LABEL_SPEC_REVIEW,
  claimPending,
  newNonce,
  pendingFileName,
  pipelineV2Enabled,
  readPending,
  releasePending,
  writePending,
  type PendingMerge,
  type PendingSpec,
} from "../../../src/tools/pipeline-pending.js";
import { parseCodingCallback } from "../../../src/gateway/coding-cards.js";
import { SHA_A, SHA_B, contractFixture } from "../../helpers/contract-fixture.js";
import { memFs } from "../../helpers/mem-fs.js";

const DIR = "/store";
const NONCE = "abcDEF123_-xyz09";

function spec(over: Partial<PendingSpec> = {}): PendingSpec {
  return {
    kind: "spec",
    nonce: NONCE,
    repo: "acme/widgets",
    issue: 12,
    contract: contractFixture({ spec_commit: SHA_B }),
    effective_risk: "low",
    fingerprint: "1".repeat(64),
    spec_commit: SHA_B,
    created_at: "2026-10-06T10:00:00.000Z",
    ...over,
  };
}

function merge(over: Partial<PendingMerge> = {}): PendingMerge {
  return {
    kind: "merge",
    nonce: "mergeNonce1",
    repo: "acme/widgets",
    issue: 12,
    pr: 40,
    evidence: { status: "PASS", reasons: [], head_sha: SHA_B },
    review: { decision: "APPROVE", head_sha: SHA_B },
    head_at_review: SHA_B,
    base_at_review: SHA_A,
    created_at: "2026-10-06T10:00:00.000Z",
    ...over,
  };
}

describe("pipelineV2Enabled", () => {
  it("is on only for exactly 1", () => {
    expect(pipelineV2Enabled({ AGENT_PIPELINE_V2: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", " 1", "1 "]) {
      expect(pipelineV2Enabled({ AGENT_PIPELINE_V2: v }), String(v)).toBe(false);
    }
  });
});

describe("labels", () => {
  it("are the three the flow moves an issue through", () => {
    expect([LABEL_SPEC, LABEL_SPEC_REVIEW, LABEL_READY]).toEqual(["agent:spec", "agent:spec-review", "agent:ready"]);
  });
});

describe("newNonce", () => {
  it("is a valid cp: nonce, unique, and fits the 64-byte callback with the longest action", () => {
    const a = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(newNonce()).not.toBe(a);
    expect(parseCodingCallback("cp:merge_ack:" + a)).toEqual({ action: "merge_ack", nonce: a });
  });
});

describe("pendingFileName", () => {
  it("refuses a nonce that could escape the directory", () => {
    for (const bad of ["", "../x", "a/b", "a.b", "a b", "x".repeat(33)]) {
      expect(pendingFileName(DIR, bad).ok, bad).toBe(false);
    }
    expect(pendingFileName(DIR, NONCE)).toEqual({ ok: true, value: "/store/pending/" + NONCE + ".json" });
  });
});

describe("writePending + readPending", () => {
  it("round-trips a spec record and a merge record", async () => {
    const fs = memFs();
    expect((await writePending(fs, DIR, spec())).ok).toBe(true);
    expect((await writePending(fs, DIR, merge())).ok).toBe(true);
    const s = await readPending(fs, DIR, NONCE);
    expect(s).toEqual({ ok: true, value: spec() });
    const m = await readPending(fs, DIR, "mergeNonce1");
    expect(m).toEqual({ ok: true, value: merge() });
  });

  it("never overwrites an existing nonce", async () => {
    const fs = memFs();
    await writePending(fs, DIR, spec());
    const again = await writePending(fs, DIR, spec({ issue: 99 }));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("exists");
    const r = await readPending(fs, DIR, NONCE);
    expect(r.ok && r.value.kind === "spec" && r.value.issue).toBe(12);
  });

  it("refuses an invalid record (contract spec_commit must match the record's)", async () => {
    const fs = memFs();
    const r = await writePending(fs, DIR, spec({ spec_commit: SHA_A }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid");
    expect(fs.files.size).toBe(0);
  });

  it("refuses a merge record whose evidence is not for the reviewed head", async () => {
    const fs = memFs();
    const r = await writePending(fs, DIR, merge({ evidence: { status: "PASS", reasons: [], head_sha: SHA_A } }));
    expect(r.ok).toBe(false);
  });

  it("reports not_found, invalid JSON and a shape mismatch as typed errors, never a partial record", async () => {
    const fs = memFs();
    const miss = await readPending(fs, DIR, NONCE);
    expect(miss.ok === false && miss.code).toBe("not_found");
    fs.files.set("/store/pending/" + NONCE + ".json", "{not json");
    const bad = await readPending(fs, DIR, NONCE);
    expect(bad.ok === false && bad.code).toBe("invalid");
    fs.files.set("/store/pending/" + NONCE + ".json", JSON.stringify({ kind: "spec", nonce: NONCE }));
    const shape = await readPending(fs, DIR, NONCE);
    expect(shape.ok === false && shape.code).toBe("invalid");
  });

  it("rejects a file whose nonce differs from its name", async () => {
    const fs = memFs();
    fs.files.set("/store/pending/" + NONCE + ".json", JSON.stringify(spec({ nonce: "otherNonce000000" })));
    const r = await readPending(fs, DIR, NONCE);
    expect(r.ok === false && r.code).toBe("invalid");
  });

  it("leaves no tmp file behind when the rename fails", async () => {
    const fs = memFs({ failRename: true });
    const r = await writePending(fs, DIR, spec());
    expect(r.ok === false && r.code).toBe("io");
    expect([...fs.files.keys()]).toEqual([]);
  });
});

describe("claimPending", () => {
  it("hands the record to exactly one of two racing taps", async () => {
    const fs = memFs();
    await writePending(fs, DIR, spec());
    const [a, b] = await Promise.all([claimPending(fs, DIR, NONCE), claimPending(fs, DIR, NONCE)]);
    const oks = [a, b].filter((x) => x.ok);
    expect(oks).toHaveLength(1);
    const loser = [a, b].find((x) => !x.ok);
    expect(loser && !loser.ok && loser.code).toBe("not_found");
  });

  it("a claimed record is not readable as open, and a second claim is not_found", async () => {
    const fs = memFs();
    await writePending(fs, DIR, spec());
    expect((await claimPending(fs, DIR, NONCE)).ok).toBe(true);
    expect((await readPending(fs, DIR, NONCE)).ok).toBe(false);
    const again = await claimPending(fs, DIR, NONCE);
    expect(again.ok === false && again.code).toBe("not_found");
  });

  it("releasePending puts it back so the founder can tap again after a transient failure", async () => {
    const fs = memFs();
    await writePending(fs, DIR, spec());
    await claimPending(fs, DIR, NONCE);
    expect((await releasePending(fs, DIR, NONCE)).ok).toBe(true);
    expect((await readPending(fs, DIR, NONCE)).ok).toBe(true);
    expect((await claimPending(fs, DIR, NONCE)).ok).toBe(true);
  });

  it("releasing something that was never claimed is an error, not a silent no-op", async () => {
    const fs = memFs();
    const r = await releasePending(fs, DIR, NONCE);
    expect(r.ok === false && r.code).toBe("not_found");
  });

  it("claims a record that fails validation as invalid, and does not hand out a partial", async () => {
    const fs = memFs();
    fs.files.set("/store/pending/" + NONCE + ".json", "{}");
    const r = await claimPending(fs, DIR, NONCE);
    expect(r.ok === false && r.code).toBe("invalid");
  });
});
