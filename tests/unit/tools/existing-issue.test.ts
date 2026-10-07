/**
 * "Start work on issue #41" names work that already has an issue.
 * ================================================================
 * Prod, 2026-10-07 10:44 UTC: the founder asked to start OplifyMessage/oplify-messaging-api #41. The bot filed
 * a NEW issue (#83) whose whole body was "Start work on issue #41", without reading #41, although PR #81
 * ("feat(catalog): add multi-product carousel support (#41)") had been merged into beta the day before.
 *
 * These are the pure pieces the dispatch path now runs first: which existing issue the request names, and
 * which pull request (from that issue's own timeline) already fixes it. The timeline fixtures are #41's real
 * cross-references: six closed, unmerged PRs that only mention it, the wrapper issue #78, the merged fix #81
 * and the wrapper issue #83.
 */

import { describe, it, expect, vi } from "vitest";
import {
  existingIssueAsk,
  fetchCrossRefPrs,
  findFixingPr,
  parseIssueReference,
  withFounderAsk,
  type CrossRefPr,
} from "../../../src/tools/existing-issue.js";
import { extractAsk } from "../../../src/tools/pipeline-spec.js";

const API = "OplifyMessage/oplify-messaging-api";

describe("parseIssueReference", () => {
  it.each([
    ["In oplify-messaging-api \nStart work on issue #41."],
    ["start issue 41"],
    ["work on issue number 41"],
    ["https://github.com/OplifyMessage/oplify-messaging-api/issues/41 please"],
    ["OplifyMessage/oplify-messaging-api#41"],
    ["feat(catalog): add multi-product carousel support (#41)"],
    ["#41"],
  ])("%j names issue 41", (text) => {
    expect(parseIssueReference(API, text)).toEqual({ kind: "one", number: 41 });
  });

  it.each([
    ["review PR #81"],
    ["look at pull request #81"],
    ["PR#81 needs a rebase"],
    ["https://github.com/OplifyMessage/oplify-messaging-api/pull/81"],
    ["fix the login button"],
    ["the label says &#39;hello&#39;"],
    ["step 2 of onboarding is slow"],
  ])("%j names no issue", (text) => {
    expect(parseIssueReference(API, text)).toEqual({ kind: "none" });
  });

  it("an issue on ANOTHER repo is not this repo's issue", () => {
    expect(parseIssueReference(API, "port the fix from pushkarverma3698/FounderOS#120")).toEqual({ kind: "none" });
    expect(parseIssueReference(API, "see https://github.com/pushkarverma3698/FounderOS/issues/120")).toEqual({ kind: "none" });
  });

  it("the same issue named in the request and the title is one issue", () => {
    expect(parseIssueReference(API, "Start work on issue #41", "Start work on issue #41", null)).toEqual({ kind: "one", number: 41 });
  });

  it("two different issues are reported as many, in the order named", () => {
    expect(parseIssueReference(API, "do issues #42 and #41")).toEqual({ kind: "many", numbers: [42, 41] });
  });

  it("the repo slug is matched case-insensitively", () => {
    expect(parseIssueReference(API, "oplifymessage/OPLIFY-messaging-api#41")).toEqual({ kind: "one", number: 41 });
  });
});

function pr(over: Partial<CrossRefPr>): CrossRefPr {
  return { repo: API, number: 1, title: "", body: "", state: "closed", mergedAt: null, url: "https://example/pr", ...over };
}

/** #41's real cross-referencing PRs, 2026-10-07 (the wrapper issues #78 and #83 are not PRs). */
const ISSUE_41_PRS: CrossRefPr[] = [
  pr({ number: 5, title: "Issue prod009 yash" }),
  pr({ number: 1, title: "Add isolated local development relay ingress", body: "## What changed\n- see #41 later" }),
  pr({ number: 52, title: "Merge the September handover, with audit fixes (supersedes #51)", body: "Open issues: #41, #46, #48" }),
  pr({ number: 53, title: "Payments phases 1C–3 + fixes from Razorpay test-mode QA and code audit" }),
  pr({ number: 54, title: "Backend stability: 289 unit tests, a CI coverage gate, and 4 prod bugs they found" }),
  pr({ number: 55, title: "Sign the OAuth state so Sheets/HubSpot/Zoho callbacks can't be pointed at another org" }),
  pr({ number: 56, title: "fix: reject non-bucket header media URLs in template creation (SSRF)" }),
  pr({
    number: 81,
    title: "feat(catalog): add multi-product carousel support (#41)",
    body: "## What changed\n\n- Extended `catalog.service.js`",
    mergedAt: "2026-10-06T09:35:19Z",
    url: "https://github.com/OplifyMessage/oplify-messaging-api/pull/81",
  }),
];

describe("findFixingPr", () => {
  it("finds PR #81 for #41 among PRs that only mention it", () => {
    expect(findFixingPr(41, API, ISSUE_41_PRS)?.number).toBe(81);
  });

  it("a merged PR that only mentions the issue in passing does not fix it", () => {
    expect(findFixingPr(41, API, [pr({ number: 9, body: "Related: #41", mergedAt: "2026-10-01T00:00:00Z" })])).toBeNull();
  });

  it.each([["Fixes #41"], ["closes #41."], ["Resolved: #41"], ["fixed OplifyMessage/oplify-messaging-api#41"]])(
    "a merged PR whose body says %j fixes it",
    (body) => {
      expect(findFixingPr(41, API, [pr({ number: 9, body, mergedAt: "2026-10-01T00:00:00Z" })])?.number).toBe(9);
    },
  );

  it("the number must match exactly: #410 is not #41", () => {
    expect(findFixingPr(41, API, [pr({ number: 9, title: "fix (#410)", body: "Fixes #410", mergedAt: "2026-10-01T00:00:00Z" })])).toBeNull();
  });

  it("a PR in another repo does not fix this repo's #41", () => {
    expect(findFixingPr(41, API, [pr({ repo: "pushkarverma3698/FounderOS", number: 9, title: "x (#41)", mergedAt: "2026-10-01T00:00:00Z" })])).toBeNull();
  });

  it("an OPEN PR that says it closes the issue is returned (work in flight), a title mention alone is not", () => {
    expect(findFixingPr(41, API, [pr({ number: 9, state: "open", body: "Closes #41" })])?.number).toBe(9);
    expect(findFixingPr(41, API, [pr({ number: 9, state: "open", title: "wip (#41)" })])).toBeNull();
  });

  it("a merged fix wins over an open one, and the latest merge wins among merged", () => {
    const open = pr({ number: 90, state: "open", body: "Closes #41" });
    const early = pr({ number: 70, title: "x (#41)", mergedAt: "2026-09-01T00:00:00Z" });
    const late = pr({ number: 81, title: "y (#41)", mergedAt: "2026-10-06T09:35:19Z" });
    expect(findFixingPr(41, API, [open, early, late])?.number).toBe(81);
  });
});

describe("fetchCrossRefPrs", () => {
  it("keeps only cross-referencing PULL REQUESTS, with their merge time", async () => {
    const events = [
      { event: "labeled" },
      {
        event: "cross-referenced",
        source: {
          issue: {
            number: 81,
            title: "feat(catalog): add multi-product carousel support (#41)",
            body: null,
            state: "closed",
            html_url: "https://github.com/OplifyMessage/oplify-messaging-api/pull/81",
            repository: { full_name: API },
            pull_request: { merged_at: "2026-10-06T09:35:19Z" },
          },
        },
      },
      {
        event: "cross-referenced",
        source: {
          issue: {
            number: 83,
            title: "Start work on issue #41",
            body: "## Goal",
            state: "open",
            html_url: "https://github.com/OplifyMessage/oplify-messaging-api/issues/83",
            repository: { full_name: API },
          },
        },
      },
    ];
    const paginate = vi.fn(async () => events);
    const octokit = { paginate, rest: { issues: { listEventsForTimeline: vi.fn() } } };

    const prs = await fetchCrossRefPrs(octokit as never, "OplifyMessage", "oplify-messaging-api", 41);

    expect(paginate).toHaveBeenCalledWith(octokit.rest.issues.listEventsForTimeline, {
      owner: "OplifyMessage",
      repo: "oplify-messaging-api",
      issue_number: 41,
      per_page: 100,
    });
    expect(prs).toEqual([
      {
        repo: API,
        number: 81,
        title: "feat(catalog): add multi-product carousel support (#41)",
        body: "",
        state: "closed",
        mergedAt: "2026-10-06T09:35:19Z",
        url: "https://github.com/OplifyMessage/oplify-messaging-api/pull/81",
      },
    ]);
  });
});

describe("withFounderAsk", () => {
  const imported = "**Severity:** P2\n\nCatalog sends only a single product card.";

  it("appends the founder's words as the section Pass P binds the spec to", () => {
    const body = withFounderAsk(imported, "In oplify-messaging-api\nStart work on issue #41.");
    expect(body.startsWith(imported)).toBe(true);
    expect(extractAsk(body)).toEqual({ ok: true, ask: "In oplify-messaging-api\nStart work on issue #41." });
  });

  it("leaves a body that already ends with an ask untouched", () => {
    const once = withFounderAsk(imported, "first ask");
    expect(withFounderAsk(once, "second ask")).toBe(once);
  });
});

describe("existingIssueAsk", () => {
  it("the founder's words first and unedited, then the issue as filed", () => {
    const ask = existingIssueAsk("In oplify-messaging-api \nStart work on issue #41.", {
      number: 41,
      title: "[PROD-010] Catalog: no multi-product carousel",
      body: "Only a single product card.\n",
    });
    expect(ask.startsWith("In oplify-messaging-api \nStart work on issue #41.\n")).toBe(true);
    expect(ask).toContain("Issue #41 as filed on GitHub: [PROD-010] Catalog: no multi-product carousel\n\nOnly a single product card.");
  });

  it("an issue with an empty body still names its title", () => {
    expect(existingIssueAsk("go", { number: 7, title: "t", body: "" })).toBe("go\n\n---\nIssue #7 as filed on GitHub: t");
  });
});
