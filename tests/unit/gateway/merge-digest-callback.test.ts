import { describe, it, expect, vi } from "vitest";
import {
  handleMergeCallback,
  _resetMergeInFlightForTests,
  type MergeDeps,
  type MergeInspection,
} from "../../../src/gateway/merge-digest-callback.js";
import { mergeCallbackData } from "../../../src/gateway/merge-digest.js";
import { DISPATCH_REPO_ALLOWLIST } from "../../../src/tools/dispatch-repos.js";

const SLUG = DISPATCH_REPO_ALLOWLIST[0]!;
const SHA = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";

const inspection = (over: Partial<MergeInspection> = {}): MergeInspection => ({
  title: "fix: the thing",
  base: "beta",
  state: "open",
  merged: false,
  draft: false,
  headSha: SHA,
  reviewedForHead: true,
  greenCI: true,
  mergeable: true,
  mergeableState: "clean",
  ...over,
});

function deps(over: Partial<MergeDeps> = {}): MergeDeps & {
  inspect: ReturnType<typeof vi.fn>;
  merge: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
} {
  return {
    inspect: vi.fn(async () => inspection()),
    merge: vi.fn(async () => undefined),
    audit: vi.fn(async () => true),
    ...over,
  } as never;
}

function ctx(data: string, messageId = 1) {
  const calls = {
    answered: [] as { text?: string; show_alert?: boolean }[],
    replies: [] as { text: string; markup?: unknown }[],
    cleared: 0,
  };
  return {
    calls,
    ctx: {
      callbackQuery: { data, message: { message_id: messageId } },
      answerCallbackQuery: vi.fn(async (o?: { text?: string; show_alert?: boolean }) => void calls.answered.push(o ?? {})),
      editMessageReplyMarkup: vi.fn(async () => void (calls.cleared += 1)),
      reply: vi.fn(async (text: string, o?: { reply_markup?: unknown }) => void calls.replies.push({ text, markup: o?.reply_markup })),
    } as never,
  };
}

const tap = (action: "ask" | "yes" | "no", pr = 12, sha = SHA) => mergeCallbackData(action, SLUG, pr, sha);

describe("handleMergeCallback", () => {
  it("returns false for a payload that is not ours, touching nothing", async () => {
    const d = deps();
    const c = ctx("jh:whatever");
    expect(await handleMergeCallback(c.ctx, d)).toBe(false);
    expect(d.inspect).not.toHaveBeenCalled();
    expect(c.calls.answered).toHaveLength(0);
  });

  it("answers a malformed payload instead of leaving the button dead", async () => {
    const d = deps();
    const c = ctx("md:zzz");
    expect(await handleMergeCallback(c.ctx, d)).toBe(true);
    expect(c.calls.answered[0]?.text).toMatch(/out of date/i);
    expect(d.merge).not.toHaveBeenCalled();
  });

  it("refuses a repo that is not allowlisted", async () => {
    const d = deps();
    const c = ctx("md:y:evil-repo:12:" + SHA.slice(0, 7));
    expect(await handleMergeCallback(c.ctx, d)).toBe(true);
    expect(d.inspect).not.toHaveBeenCalled();
    expect(d.merge).not.toHaveBeenCalled();
  });

  it("first tap re-checks and asks; it never merges", async () => {
    _resetMergeInFlightForTests();
    const d = deps();
    const c = ctx(tap("ask"));
    await handleMergeCallback(c.ctx, d);
    expect(d.inspect).toHaveBeenCalledOnce();
    expect(d.merge).not.toHaveBeenCalled();
    expect(c.calls.replies[0]?.text).toContain("Merge");
    expect(c.calls.replies[0]?.markup).toBeDefined();
  });

  it("first tap on a PR that stopped being ready says why and offers no confirm", async () => {
    const d = deps({ inspect: vi.fn(async () => inspection({ greenCI: false })) });
    const c = ctx(tap("ask"));
    await handleMergeCallback(c.ctx, d);
    expect(c.calls.replies[0]?.text).toMatch(/CI is not green/);
    expect(c.calls.replies[0]?.markup).toBeUndefined();
    expect(d.merge).not.toHaveBeenCalled();
  });

  it("cancel merges nothing and clears the buttons", async () => {
    const d = deps();
    const c = ctx(tap("no"));
    await handleMergeCallback(c.ctx, d);
    expect(d.inspect).not.toHaveBeenCalled();
    expect(d.merge).not.toHaveBeenCalled();
    expect(c.calls.cleared).toBe(1);
  });

  it("confirm re-verifies, merges pinned to the head, then writes one audit row", async () => {
    _resetMergeInFlightForTests();
    const d = deps();
    const c = ctx(tap("yes"));
    await handleMergeCallback(c.ctx, d);
    expect(d.inspect).toHaveBeenCalledOnce();
    expect(d.merge).toHaveBeenCalledWith(SLUG, 12, SHA);
    expect(d.audit).toHaveBeenCalledOnce();
    expect(d.audit.mock.calls[0]![0]).toMatchObject({ slug: SLUG, pr: 12, sha: SHA });
    expect(c.calls.replies.at(-1)?.text).toMatch(/Merged/);
  });

  it("confirm after the head moved merges nothing and writes no audit row", async () => {
    _resetMergeInFlightForTests();
    const d = deps({ inspect: vi.fn(async () => inspection({ headSha: "f".repeat(40) })) });
    const c = ctx(tap("yes"));
    await handleMergeCallback(c.ctx, d);
    expect(d.merge).not.toHaveBeenCalled();
    expect(d.audit).not.toHaveBeenCalled();
    expect(c.calls.replies.at(-1)?.text).toMatch(/New commits landed/);
  });

  it("a failed merge is reported with GitHub's reason and writes no audit row", async () => {
    _resetMergeInFlightForTests();
    const d = deps({ merge: vi.fn(async () => { throw new Error("Base branch was modified"); }) });
    const c = ctx(tap("yes"));
    await handleMergeCallback(c.ctx, d);
    expect(d.audit).not.toHaveBeenCalled();
    expect(c.calls.replies.at(-1)?.text).toContain("Base branch was modified");
    expect(c.calls.replies.at(-1)?.text).toMatch(/Nothing was merged/);
  });

  it("an unreadable PR on confirm merges nothing", async () => {
    _resetMergeInFlightForTests();
    const d = deps({ inspect: vi.fn(async () => { throw new Error("502"); }) });
    const c = ctx(tap("yes"));
    await handleMergeCallback(c.ctx, d);
    expect(d.merge).not.toHaveBeenCalled();
    expect(c.calls.replies.at(-1)?.text).toContain("502");
  });

  it("an audit failure after a real merge still says merged", async () => {
    _resetMergeInFlightForTests();
    const d = deps({ audit: vi.fn(async () => { throw new Error("db down"); }) });
    const c = ctx(tap("yes"));
    await handleMergeCallback(c.ctx, d);
    expect(d.merge).toHaveBeenCalledOnce();
    expect(c.calls.replies.at(-1)?.text).toMatch(/Merged/);
    expect(c.calls.replies.at(-1)?.text).toMatch(/audit/i);
  });

  it("two simultaneous confirms merge once", async () => {
    _resetMergeInFlightForTests();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const d = deps({ inspect: vi.fn(async () => { await gate; return inspection(); }) });
    const a = ctx(tap("yes"), 1);
    const b = ctx(tap("yes"), 2);
    const first = handleMergeCallback(a.ctx, d);
    const second = handleMergeCallback(b.ctx, d);
    release();
    await Promise.all([first, second]);
    expect(d.merge).toHaveBeenCalledOnce();
    expect(b.calls.answered.some((x) => /already/i.test(x.text ?? ""))).toBe(true);
  });
});
