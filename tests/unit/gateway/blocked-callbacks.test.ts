/**
 * The Fix now / Close PR buttons under the card pr-brain sends when it blocks a PR (cp:fix, cp:close_pr).
 * Drives the real handler through handleCodingCallback with a real pending store on an in-memory fs; GitHub, the job
 * socket and the audit table are fakes. Asserts what the founder sees and what reached GitHub and the job socket.
 */
import { describe, it, expect, vi } from "vitest";
import type { Context } from "grammy";
import { handleCodingCallback, type CodingDeps, type PrState } from "../../../src/gateway/coding-callbacks.js";
import type { BlockedActions } from "../../../src/gateway/blocked-callbacks.js";
import { fixBlockedPrKey } from "../../../src/agents/agent-tools/blocked-pr-fix.js";
import { readPending, writePending, type PendingFix } from "../../../src/tools/pipeline-pending.js";
import { memFs } from "../../helpers/mem-fs.js";

const REPO = "OplifyMessage/oplify-messaging-api";
const PR = 116;
const ISSUE = 115;
const DIR = "/store";
const NONCE = "fixNonce0000001";
const HEAD = "a".repeat(40);
const MOVED = "b".repeat(40);

const record = (over: Partial<PendingFix> = {}): PendingFix => ({
  kind: "fix",
  nonce: NONCE,
  repo: REPO,
  pr: PR,
  issue: ISSUE,
  head: HEAD,
  branch: "task/issue-115-auth",
  blockers: 2,
  created_at: "2026-10-09T10:00:00.000Z",
  ...over,
});

interface Harness {
  deps: CodingDeps;
  acts: BlockedActions;
  fs: ReturnType<typeof memFs>;
  fixes: Array<{ repo: string; issue: number; head: string }>;
  closes: Array<{ repo: string; pr: number; note: string }>;
  audits: Array<{ action: string; key: string; payload: Record<string, unknown> }>;
  audited: Set<string>;
  pr: PrState;
  fixResult: { status: "inert" | "started" } | { status: "failed"; reason: string };
  closeFails?: string;
}

function harness(over: { env?: Record<string, string | undefined>; pr?: Partial<PrState> } = {}): Harness {
  const fs = memFs();
  const h: Harness = {
    fs,
    fixes: [],
    closes: [],
    audits: [],
    audited: new Set(),
    pr: { state: "open", merged: false, headSha: HEAD, baseSha: "c".repeat(40), baseRef: "beta", ...over.pr },
    fixResult: { status: "started" },
    deps: undefined as unknown as CodingDeps,
    acts: undefined as unknown as BlockedActions,
  };
  h.deps = {
    // The pipeline flag is OFF on purpose: the blocked card must work on the legacy path too.
    env: { ...over.env },
    fs,
    dir: DIR,
    now: () => new Date("2026-10-09T10:30:00.000Z"),
    async setLabels() {},
    async comment() {},
    async startJob() {
      return { status: "started" as const };
    },
    async inspectPr() {
      return h.pr;
    },
    async merge() {
      throw new Error("a blocked-card tap must never merge");
    },
    async updateBranch() {},
    async alreadyDone(key) {
      return h.audited.has(key);
    },
    async audit(row) {
      h.audits.push(row);
      h.audited.add(row.key);
      return true;
    },
  };
  h.acts = {
    async startFix(repo, issue, head) {
      h.fixes.push({ repo, issue, head });
      return h.fixResult;
    },
    async closePr(repo, pr, note) {
      if (h.closeFails !== undefined) throw new Error(h.closeFails);
      h.closes.push({ repo, pr, note });
    },
  };
  return h;
}

function ctxFor(data: string) {
  const answer = vi.fn(async () => true);
  const reply = vi.fn(async () => ({}));
  const clear = vi.fn(async () => true);
  const ctx = { callbackQuery: { data }, answerCallbackQuery: answer, reply, editMessageReplyMarkup: clear } as unknown as Context;
  const said = () => reply.mock.calls.map((c) => String((c as unknown[])[0])).join("\n");
  return { ctx, answer, reply, clear, said };
}

const tap = (h: Harness, action: string, nonce = NONCE) => {
  const c = ctxFor(`cp:${action}:${nonce}`);
  return handleCodingCallback(c.ctx, h.deps, h.acts).then((handled) => ({ handled, ...c }));
};

async function seed(h: Harness, rec: PendingFix = record()): Promise<void> {
  expect((await writePending(h.fs, DIR, rec)).ok).toBe(true);
}

describe("Fix now", () => {
  it("starts the fix for the head on the card, with the pipeline flag off, and says what it started", async () => {
    const h = harness();
    await seed(h);
    const r = await tap(h, "fix");
    expect(r.handled).toBe(true);
    expect(h.fixes).toEqual([{ repo: REPO, issue: ISSUE, head: HEAD }]);
    expect(r.said()).toContain("Fix started now on branch task/issue-115-auth");
    expect(r.said()).toContain("2 blockers");
    expect(r.clear).toHaveBeenCalled();
    expect(h.audits).toHaveLength(1);
    // The same key the chat tool uses: a chat "fix it" for this head after the tap starts nothing twice.
    expect(h.audits[0]?.key).toBe(fixBlockedPrKey(REPO, ISSUE, HEAD));
  });

  it("a second tap (or a chat 'fix it') for the same head starts nothing", async () => {
    const h = harness();
    await seed(h);
    await tap(h, "fix");
    await seed(h, record({ nonce: "fixNonce0000002" }));
    const again = await tap(h, "fix", "fixNonce0000002");
    expect(h.fixes).toHaveLength(1);
    expect(again.said()).toMatch(/already started/i);
  });

  it("refuses when the PR has a new commit since the card, and starts nothing", async () => {
    const h = harness({ pr: { headSha: MOVED } });
    await seed(h);
    const r = await tap(h, "fix");
    expect(h.fixes).toEqual([]);
    expect(r.said()).toContain("aaaaaaa");
    expect(r.said()).toContain("bbbbbbb");
    expect(r.said()).toMatch(/new commit gets its own review/i);
  });

  it("refuses a merged or closed PR", async () => {
    for (const pr of [{ merged: true, state: "closed" as const }, { state: "closed" as const }]) {
      const h = harness({ pr });
      await seed(h);
      const r = await tap(h, "fix");
      expect(h.fixes).toEqual([]);
      expect(r.said()).toMatch(/already merged|closed without merging/);
    }
  });

  it("a failed hand-off is reported with its reason and the card stays usable", async () => {
    const h = harness();
    h.fixResult = { status: "failed", reason: "connect ENOENT /run/fos-job.sock" };
    await seed(h);
    const r = await tap(h, "fix");
    expect(r.said()).toContain("connect ENOENT /run/fos-job.sock");
    expect(r.said()).toMatch(/Nothing is running it/);
    expect(h.audits).toEqual([]);
    expect((await readPending(h.fs, DIR, NONCE)).ok).toBe(true);
  });

  it("on a host that runs no jobs it says nothing was started", async () => {
    const h = harness();
    h.fixResult = { status: "inert" };
    await seed(h);
    const r = await tap(h, "fix");
    expect(r.said()).toMatch(/Nothing was started/);
    expect(h.audits).toEqual([]);
  });

  it("a PR with no linked issue cannot be fixed from the card", async () => {
    const h = harness();
    await seed(h, record({ issue: undefined }));
    const r = await tap(h, "fix");
    expect(h.fixes).toEqual([]);
    expect(r.said()).toMatch(/not linked to an issue/i);
  });

  it("a repo the bot does not act on is refused", async () => {
    const h = harness();
    await seed(h, record({ repo: "stranger/elsewhere" }));
    const r = await tap(h, "fix");
    expect(h.fixes).toEqual([]);
    expect(r.said()).toMatch(/Nothing was changed/);
  });
});

describe("Close PR", () => {
  it("closes the PR and says it can be reopened", async () => {
    const h = harness();
    await seed(h);
    const r = await tap(h, "close_pr");
    expect(h.closes).toHaveLength(1);
    expect(h.closes[0]).toMatchObject({ repo: REPO, pr: PR });
    expect(h.closes[0]?.note).toContain("2 blockers");
    expect(r.said()).toContain("Closed PR #116");
    expect(r.said()).toMatch(/Reopen/i);
    expect(r.clear).toHaveBeenCalled();
    expect(h.fixes).toEqual([]);
  });

  it("does not close a PR that moved on since the card", async () => {
    const h = harness({ pr: { headSha: MOVED } });
    await seed(h);
    const r = await tap(h, "close_pr");
    expect(h.closes).toEqual([]);
    expect(r.said()).toMatch(/new commit/i);
  });

  it("GitHub refusing the close is reported and the card stays usable", async () => {
    const h = harness();
    h.closeFails = "Resource not accessible by integration";
    await seed(h);
    const r = await tap(h, "close_pr");
    expect(r.said()).toContain("Resource not accessible by integration");
    expect((await readPending(h.fs, DIR, NONCE)).ok).toBe(true);
  });

  it("a double delivery closes once", async () => {
    const h = harness();
    await seed(h);
    await tap(h, "close_pr");
    const second = await tap(h, "close_pr");
    expect(h.closes).toHaveLength(1);
    expect(second.said()).toMatch(/already used/i);
  });
});

describe("wrong card", () => {
  it("a fix tap whose record is not a fix record changes nothing", async () => {
    const h = harness();
    const w = await writePending(h.fs, DIR, {
      kind: "merge",
      nonce: NONCE,
      repo: REPO,
      issue: 1,
      pr: 1,
      evidence: { status: "PASS", reasons: [], head_sha: HEAD },
      review: { decision: "APPROVE", head_sha: HEAD },
      head_at_review: HEAD,
      base_at_review: "c".repeat(40),
      created_at: "2026-10-09T10:00:00.000Z",
    });
    expect(w.ok).toBe(true);
    const r = await tap(h, "fix");
    expect(h.fixes).toEqual([]);
    expect(r.said()).toMatch(/Wrong card|not a fix/i);
    expect((await readPending(h.fs, DIR, NONCE)).ok).toBe(true);
  });
});
