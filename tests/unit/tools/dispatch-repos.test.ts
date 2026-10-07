/**
 * Unit tests for the Antigravity dispatch repo allowlist.
 *
 * This is a security boundary, not a formatting helper: the VPS GITHUB_TOKEN carries
 * `repo`, `admin:org` and `delete_repo`, and `repo` is a model-supplied argument. The
 * cases that matter most here are the refusals — an off-list slug and an off-list
 * environment variable both have to fail loudly rather than resolve to something.
 */

import { describe, it, expect } from "vitest";

const {
  DISPATCH_REPO_ALLOWLIST,
  DEFAULT_DISPATCH_REPO,
  normalizeRepoSlug,
  assertAllowedRepo,
  matchAllowlistedRepos,
  assertDispatchableRepo,
  findRepoNamedInText,
} = await import("../../../src/tools/dispatch-repos.js");

/**
 * The repos the loop is provisioned for, in allowlist order. `pnpm repo:add <owner/repo>`
 * (scripts/repo-add.ts) appends to this list together with DISPATCH_REPO_ALLOWLIST and
 * DEFAULT_REPOS in deploy/agent-dispatch. Pinning it here means the allowlist can only grow
 * as a reviewed line in a diff, never as a side effect.
 */
const PROVISIONED_REPOS = [
  "pushkarverma3698/FounderOS",
  "pushkarverma3698/House-of-Hulda-Website-frontend",
  "OplifyMessage/oplify-messaging-app",
  "OplifyMessage/oplify-messaging-api",
  "pushkarverma3698/fos-journey-sandbox",
] as const;

/** True when the repo-name half of `owner/repo` contains `hint`: the rule `/task repo:<hint>` matches on. */
const nameContains = (slug: string, hint: string): boolean =>
  (slug.split("/")[1] ?? "").toLowerCase().includes(hint);

describe("DISPATCH_REPO_ALLOWLIST", () => {
  it("contains exactly the repos the loop is provisioned for", () => {
    expect([...DISPATCH_REPO_ALLOWLIST]).toEqual([...PROVISIONED_REPOS]);
  });

  it("defaults to FounderOS", () => {
    expect(DEFAULT_DISPATCH_REPO).toBe("pushkarverma3698/FounderOS");
  });
});

describe("normalizeRepoSlug", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeRepoSlug("  owner/repo  ")).toBe("owner/repo");
  });

  it("strips a github URL prefix", () => {
    expect(normalizeRepoSlug("https://github.com/owner/repo")).toBe("owner/repo");
    expect(normalizeRepoSlug("http://github.com/owner/repo")).toBe("owner/repo");
    expect(normalizeRepoSlug("github.com/owner/repo")).toBe("owner/repo");
  });

  it("strips a .git suffix and a trailing slash", () => {
    expect(normalizeRepoSlug("owner/repo.git")).toBe("owner/repo");
    expect(normalizeRepoSlug("owner/repo/")).toBe("owner/repo");
    expect(normalizeRepoSlug("https://github.com/owner/repo.git")).toBe("owner/repo");
  });
});

describe("assertAllowedRepo", () => {
  it("accepts an allowlisted slug", () => {
    expect(assertAllowedRepo("pushkarverma3698/FounderOS")).toEqual({
      owner: "pushkarverma3698",
      repo: "FounderOS",
    });
    expect(assertAllowedRepo("pushkarverma3698/House-of-Hulda-Website-frontend")).toEqual({
      owner: "pushkarverma3698",
      repo: "House-of-Hulda-Website-frontend",
    });
    expect(assertAllowedRepo("OplifyMessage/oplify-messaging-app")).toEqual({
      owner: "OplifyMessage",
      repo: "oplify-messaging-app",
    });
    expect(assertAllowedRepo("OplifyMessage/oplify-messaging-api")).toEqual({
      owner: "OplifyMessage",
      repo: "oplify-messaging-api",
    });
  });

  it("matches case-insensitively but returns the canonical casing", () => {
    // GitHub itself is case-insensitive on owner/repo, so "founderos" is the same
    // repository — but everything downstream (branch names, the HITL card, log lines)
    // should read the one canonical spelling.
    expect(assertAllowedRepo("PUSHKARVERMA3698/founderos")).toEqual({
      owner: "pushkarverma3698",
      repo: "FounderOS",
    });
  });

  it("accepts a github URL for an allowlisted repo", () => {
    expect(assertAllowedRepo("https://github.com/pushkarverma3698/FounderOS.git")).toEqual({
      owner: "pushkarverma3698",
      repo: "FounderOS",
    });
  });

  it("refuses a repo that is not on the allowlist", () => {
    expect(() => assertAllowedRepo("custom-owner/custom-repo")).toThrow(
      /not on the Antigravity dispatch allowlist/,
    );
  });

  it("names both allowed repos and the source of truth in the refusal", () => {
    // The message reaches the model as a tool result. Without the "no runtime override"
    // clause it retries with a rephrased slug instead of stopping.
    let message = "";
    try {
      assertAllowedRepo("someone-else/private-thing");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("someone-else/private-thing");
    expect(message).toContain("pushkarverma3698/FounderOS");
    expect(message).toContain("pushkarverma3698/House-of-Hulda-Website-frontend");
    expect(message).toContain("src/tools/dispatch-repos.ts");
    expect(message).toContain("no runtime override");
  });

  it("distinguishes a malformed slug from a refused one", () => {
    // "you typed it wrong" and "you may not target that" are different facts and must
    // not collapse into one message.
    expect(() => assertAllowedRepo("invalid-slug-without-slash")).toThrow(/Invalid repository slug/);
    expect(() => assertAllowedRepo("")).toThrow(/Invalid repository slug/);
  });

  it("rejects a three-part slug instead of silently truncating it", () => {
    // The old slash-split resolved "a/b/c" to owner "a", repo "b".
    expect(() => assertAllowedRepo("pushkarverma3698/FounderOS/extra")).toThrow(
      /Invalid repository slug/,
    );
  });
});

describe("matchAllowlistedRepos", () => {
  it("resolves an exact slug to exactly one match", () => {
    expect(matchAllowlistedRepos("pushkarverma3698/FounderOS")).toEqual([
      "pushkarverma3698/FounderOS",
    ]);
  });

  it("resolves a short name hint case-insensitively", () => {
    expect(matchAllowlistedRepos("hulda")).toEqual([
      "pushkarverma3698/House-of-Hulda-Website-frontend",
    ]);
    expect(matchAllowlistedRepos("FounderOS")).toEqual(["pushkarverma3698/FounderOS"]);
  });

  it("returns every match for an ambiguous hint so the caller can refuse", () => {
    // Every allowlisted repo whose name contains "o" is a match. Silently picking the first
    // would retarget the dispatch to a repo the founder did not name. Derived from the
    // allowlist, not hard-coded, so `pnpm repo:add` cannot break it by adding a repo.
    const containingO = DISPATCH_REPO_ALLOWLIST.filter((slug) => nameContains(slug, "o"));
    expect(containingO.length).toBeGreaterThan(1);
    expect(matchAllowlistedRepos("o")).toEqual(containingO);
  });

  it("resolves an unambiguous Oplify hint to the right side", () => {
    expect(matchAllowlistedRepos("oplify-messaging-app")).toEqual([
      "OplifyMessage/oplify-messaging-app",
    ]);
    expect(matchAllowlistedRepos("oplify-messaging-api")).toEqual([
      "OplifyMessage/oplify-messaging-api",
    ]);
  });

  it("returns no matches for an unknown hint", () => {
    expect(matchAllowlistedRepos("linkedin-growth-engine-v2")).toEqual([]);
    expect(matchAllowlistedRepos("")).toEqual([]);
  });

  it("matches on the repo name only, never the owner", () => {
    // Otherwise "pushkarverma3698" matches everything and reads as ambiguous.
    expect(matchAllowlistedRepos("pushkarverma3698")).toEqual([]);
  });
});

// ── Repos this instance created for the founder ──────────────────────────────
//
// A brand-new project repo cannot be in the hardcoded list — it did not exist when
// the code was written. It becomes dispatchable by a different route: FounderOS
// created it, under the founder's own account, behind an approval card, and recorded
// that fact. The security property is unchanged — the model still cannot name an
// arbitrary repository, because naming one is not how a repo gets in here.

const REGISTERED = ["pushkarverma3698/turicks-pricing-api"] as const;

describe("assertDispatchableRepo — hardcoded list plus registered project repos", () => {
  it("accepts a hardcoded repo with no registered repos at all", () => {
    expect(assertDispatchableRepo("pushkarverma3698/FounderOS", [])).toEqual({
      owner: "pushkarverma3698",
      repo: "FounderOS",
    });
  });

  it("accepts a registered repo that is not on the hardcoded list", () => {
    expect(assertDispatchableRepo("pushkarverma3698/turicks-pricing-api", REGISTERED)).toEqual({
      owner: "pushkarverma3698",
      repo: "turicks-pricing-api",
    });
  });

  it("normalizes a registered repo the same way as a hardcoded one", () => {
    expect(
      assertDispatchableRepo("https://github.com/pushkarverma3698/turicks-pricing-api.git", REGISTERED),
    ).toEqual({ owner: "pushkarverma3698", repo: "turicks-pricing-api" });
  });

  it("matches a registered repo case-insensitively", () => {
    expect(assertDispatchableRepo("pushkarverma3698/TURICKS-PRICING-API", REGISTERED).repo).toBe(
      "turicks-pricing-api",
    );
  });

  it("still refuses a repo that is neither hardcoded nor registered", () => {
    expect(() => assertDispatchableRepo("someone-else/private-thing", REGISTERED)).toThrow(
      /not on the Antigravity dispatch allowlist/,
    );
  });

  it("refuses a registered entry that is not a well-formed slug, rather than trusting the store", () => {
    // The registry is data read back out of the database. Treating it as pre-validated
    // would make a corrupt row a way past the boundary.
    expect(() => assertDispatchableRepo("not-a-slug", ["not-a-slug"])).toThrow(
      /Expected "owner\/repo"/,
    );
  });

  it("names the registered repos in the refusal so the founder can see what IS allowed", () => {
    expect(() => assertDispatchableRepo("nope/nope", REGISTERED)).toThrow(
      /turicks-pricing-api/,
    );
  });

  it("still refuses a malformed slug with the typo message, not the policy message", () => {
    expect(() => assertDispatchableRepo("owner/repo/extra", REGISTERED)).toThrow(
      /Expected "owner\/repo"/,
    );
  });
});

describe("matchAllowlistedRepos — with registered project repos", () => {
  it("finds a registered repo by short hint", () => {
    expect(matchAllowlistedRepos("pricing", REGISTERED)).toEqual([
      "pushkarverma3698/turicks-pricing-api",
    ]);
  });

  it("reports ambiguity across the hardcoded list and the registry together", () => {
    // Without this the founder gets a silent retarget when a new project's name
    // happens to overlap an existing one. Derived from the lists, not hard-coded, so
    // `pnpm repo:add` cannot break it by adding a repo whose name contains an "r".
    const containingR = [...DISPATCH_REPO_ALLOWLIST, ...REGISTERED].filter((slug) => nameContains(slug, "r"));
    expect(containingR).toContain("pushkarverma3698/FounderOS");
    expect(containingR).toContain("pushkarverma3698/turicks-pricing-api");
    expect(matchAllowlistedRepos("r", REGISTERED)).toEqual(containingR);
  });

  it("ignores a duplicate registration rather than reporting it as ambiguous", () => {
    // The same repo recorded twice is one repo. Reporting "ambiguous" here would
    // block dispatch on a bookkeeping detail the founder cannot see or fix.
    expect(matchAllowlistedRepos("FounderOS", ["pushkarverma3698/FounderOS"])).toEqual([
      "pushkarverma3698/FounderOS",
    ]);
  });

  it("behaves exactly as before when no registry is passed", () => {
    expect(matchAllowlistedRepos("hulda")).toEqual([
      "pushkarverma3698/House-of-Hulda-Website-frontend",
    ]);
  });
});

describe("findRepoNamedInText — a repo named anywhere in the request", () => {
  // Prod 2026-10-07 10:40 UTC: "/task In oplify-messaging-api \nStart work on issue #41." got "Which repo?".
  it.each([
    ["In oplify-messaging-api \nStart work on issue #41.", "OplifyMessage/oplify-messaging-api"],
    ["start work on oplify-messaging-api#41", "OplifyMessage/oplify-messaging-api"],
    ["see https://github.com/OplifyMessage/oplify-messaging-app/issues/12 and fix it", "OplifyMessage/oplify-messaging-app"],
    ["the hero on (hulda) is broken", "pushkarverma3698/House-of-Hulda-Website-frontend"],
    ["fix founderos", "pushkarverma3698/FounderOS"],
  ])("%j names %s", (text, repo) => {
    expect(findRepoNamedInText(text)).toBe(repo);
  });

  it.each([
    ["fix the flaky CSV export"],
    ["app fix the login button"],
    ["api is slow"],
    ["mention repo:hulda in the readme"],
    ["try it in a sandbox first"],
    ["port the oplify-api retry into founderos"],
  ])("%j names no single repo", (text) => {
    expect(findRepoNamedInText(text)).toBeNull();
  });

  it("a registered project repo counts by its exact name", () => {
    expect(findRepoNamedInText("add a readme to my-side-project", ["pushkarverma3698/my-side-project"])).toBe("pushkarverma3698/my-side-project");
  });
});
