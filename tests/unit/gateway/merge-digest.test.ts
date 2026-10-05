import { describe, it, expect } from "vitest";
import {
  MAX_DIGEST_PRS,
  mergeCallbackData,
  mergeVerdict,
  parseMergeCallback,
  renderMergeConfirm,
  renderMergeDigest,
  resolveMergeRepo,
  type MergeFacts,
} from "../../../src/gateway/merge-digest.js";
import { DISPATCH_REPO_ALLOWLIST } from "../../../src/tools/dispatch-repos.js";
import type { ReadyMergePr } from "../../../src/gateway/tasks-ready.js";

const SHA = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
const pr = (over: Partial<ReadyMergePr> = {}): ReadyMergePr => ({
  repo: "pushkarverma3698/FounderOS",
  prNumber: 12,
  title: "fix: the thing",
  url: "https://github.com/pushkarverma3698/FounderOS/pull/12",
  headSha: SHA,
  base: "beta",
  ...over,
});

const facts = (over: Partial<MergeFacts> = {}): MergeFacts => ({
  state: "open",
  merged: false,
  draft: false,
  headSha: SHA,
  expectedSha7: SHA.slice(0, 7),
  reviewedForHead: true,
  greenCI: true,
  mergeable: true,
  mergeableState: "clean",
  ...over,
});

describe("merge callback payload", () => {
  it("round-trips and stays under Telegram's 64-byte limit for every allowlisted repo", () => {
    for (const slug of DISPATCH_REPO_ALLOWLIST) {
      for (const action of ["ask", "yes", "no"] as const) {
        const data = mergeCallbackData(action, slug, 9_999_999, SHA);
        expect(Buffer.byteLength(data), data).toBeLessThanOrEqual(64);
        expect(parseMergeCallback(data)).toEqual({
          action,
          repoName: slug.split("/")[1],
          pr: 9_999_999,
          sha7: SHA.slice(0, 7),
        });
      }
    }
  });

  it("rejects payloads that are not exactly ours", () => {
    for (const bad of ["md:", "md:x:repo:1:abcdef0", "md:a:repo:1:abc", "md:a:re po:1:abcdef0", "md:a:repo:x:abcdef0", "md:a:repo:1:ABCDEF0", "jh:a:repo:1:abcdef0", "md:a:../x:1:abcdef0/"]) {
      expect(parseMergeCallback(bad), bad).toBeNull();
    }
  });

  it("resolves a repo name only to an allowlisted slug, never to an owner taken from the payload", () => {
    const slug = DISPATCH_REPO_ALLOWLIST[0]!;
    expect(resolveMergeRepo(slug.split("/")[1]!)).toBe(slug);
    expect(resolveMergeRepo("not-a-repo")).toBeNull();
    expect(resolveMergeRepo("")).toBeNull();
  });
});

describe("renderMergeDigest", () => {
  it("is silent when nothing is ready and nothing is unreadable", () => {
    expect(renderMergeDigest([], [])).toBeNull();
  });

  it("lists each PR with one button pinned to its head", () => {
    const d = renderMergeDigest([pr(), pr({ prNumber: 13, title: "second" })])!;
    expect(d.text).toContain("2 ready to merge");
    expect(d.text).toContain("#12");
    expect(d.buttons).toHaveLength(2);
    expect(parseMergeCallback(d.buttons[0]!.data)).toMatchObject({ action: "ask", pr: 12, sha7: SHA.slice(0, 7) });
  });

  it("warns on a PR that deploys on merge and escapes HTML in titles", () => {
    const d = renderMergeDigest([pr({ base: "main", title: "<b>&x" })])!;
    expect(d.text).toContain("deploys on merge");
    expect(d.text).not.toContain("<b>&x");
  });

  it("gives no button to a PR whose head is unknown, and says nothing about it", () => {
    expect(renderMergeDigest([pr({ headSha: undefined })], [])).toBeNull();
  });

  it("caps the buttons and says how many are left", () => {
    const many = Array.from({ length: MAX_DIGEST_PRS + 3 }, (_, i) => pr({ prNumber: i + 1 }));
    const d = renderMergeDigest(many)!;
    expect(d.buttons).toHaveLength(MAX_DIGEST_PRS);
    expect(d.text).toContain("+3 more");
  });

  it("stays under Telegram's message limit with long titles and many unreadable repos", () => {
    const long = "x".repeat(300);
    const many = Array.from({ length: MAX_DIGEST_PRS + 3 }, (_, i) => pr({ prNumber: i + 1, title: long }));
    const miss = Array.from({ length: 12 }, () => ({ repo: "o/r", error: long }));
    const d = renderMergeDigest(many, miss)!;
    expect(d.text.length).toBeLessThan(4096);
    expect(d.text).toContain("+7 more could not be read");
  });

  it("always reports an unreadable repo, even with nothing ready", () => {
    const d = renderMergeDigest([], [{ repo: "OplifyMessage/app", error: "Bad credentials" }])!;
    expect(d.text).toContain("could not be read");
    expect(d.text).toContain("Bad credentials");
    expect(d.buttons).toHaveLength(0);
  });
});

describe("renderMergeConfirm", () => {
  it("names the target branch and offers a confirm and a cancel", () => {
    const c = renderMergeConfirm({ repo: "pushkarverma3698/FounderOS", pr: 12, title: "t", base: "main", sha7: SHA.slice(0, 7) });
    expect(c.text).toContain("main deploys on merge");
    expect(c.buttons.map((b) => parseMergeCallback(b.data)?.action)).toEqual(["yes", "no"]);
  });
});

describe("mergeVerdict", () => {
  it("passes a reviewed, green, clean PR whose head is the one listed", () => {
    expect(mergeVerdict(facts())).toEqual({ ok: true });
  });

  const refusals: [string, Partial<MergeFacts>, RegExp][] = [
    ["already merged", { merged: true, state: "closed" }, /already merged/],
    ["closed unmerged", { state: "closed" }, /closed without merging/],
    ["head moved", { headSha: "f".repeat(40) }, /New commits landed/],
    ["draft", { draft: true }, /draft/],
    ["review is for an older head", { reviewedForHead: false }, /review does not cover/],
    ["CI not green", { greenCI: false }, /CI is not green/],
    ["mergeability still computing", { mergeable: null }, /still working out/],
    ["conflict", { mergeable: false }, /conflicts/],
    ["dirty", { mergeableState: "dirty" }, /conflicts/],
    ["behind", { mergeableState: "behind" }, /behind/],
    ["blocked", { mergeableState: "blocked" }, /protection/],
  ];
  for (const [name, over, reason] of refusals) {
    it(`refuses: ${name}`, () => {
      const v = mergeVerdict(facts(over));
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(reason);
    });
  }

  it("marks 'already merged' so the caller can say it plainly instead of calling it an error", () => {
    const v = mergeVerdict(facts({ merged: true, state: "closed" }));
    expect(v).toMatchObject({ ok: false, already: true });
  });
});
