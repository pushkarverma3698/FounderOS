/**
 * Unit tests — the jobhunt findings analyzer (plan part C1).
 * ===========================================================
 * Pure function over already-read rows, so every case is an array literal.
 *
 * THE FAILURES THESE GUARD AGAINST.
 *  · A FALSE ISSUE. This analyzer feeds an unattended loop that files GitHub
 *    issues and spends a paid Antigravity run per claim. The negatives here
 *    (weekend lull, rate-limited platform, sweeps that never ran, an employer's
 *    own domain) are the tests that keep it from crying wolf.
 *  · A SILENT SENSOR. Empty input must produce nothing, never a finding computed
 *    from nothing, and a finding's evidence must be rows that were in the input.
 *  · FINGERPRINT CHURN. One persistent defect must keep one identity from day to
 *    day or the 1-issue-total dedupe (edge case "persists for 10 days") breaks.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ADAPTER_SILENT_MAX_FAILING_SWEEP_SHARE,
  ADAPTER_SILENT_MIN_BASELINE_ROWS,
  ADAPTER_SILENT_MIN_LANE_SHARE,
  ADAPTER_SILENT_MIN_SWEEP_RUNS,
  ADAPTER_SOURCE_PATHS,
  APPLY_LINK_MAX_MISSING_SHARE,
  APPLY_LINK_MIN_ROWS,
  CANDIDATE_NOT_ACTING_MIN_ACTIONABLE,
  LANE_SILENT_MIN_STREAK,
  SWEEP_INTERVAL_MINUTES,
  analyzeJobhunt,
  failedPlatformsOf,
  findAdapterSilent,
  findApplyLinkUnrecognised,
  findCandidateNotActing,
  findLaneSilent,
  type ApplyActivityRow,
  type JobhuntSnapshot,
  type LaneHeartbeatRow,
  type NewPostingRow,
} from "../../../src/evolution/analyzers/jobhunt.js";
import { ADAPTERS } from "../../../src/tools/jobhunt/adapters/index.js";
import { FREE_SWEEP_CRON } from "../../../src/tools/jobhunt/sweep-runner.js";
import { ZERO_PASS_STREAK_THRESHOLD } from "../../../src/tools/jobhunt/sweep-heartbeat.js";
import { computeFingerprint } from "../../../src/evolution/fingerprint.js";
import { summariseFailures } from "../../../src/tools/jobhunt/free-ats-source.js";

import { DAY, NOW, healthy, postings, sweepRuns, withSilent } from "../../helpers/jobhunt-fixtures.js";

function urlsIn(rows: readonly NewPostingRow[]): Set<string> {
  return new Set(rows.map((r) => r.url));
}

describe("thresholds are the plan's numbers, not invented ones", () => {
  it("the apply-link share is the plan's 30%", () => {
    expect(APPLY_LINK_MAX_MISSING_SHARE).toBe(0.3);
  });

  it("the lane-silent streak IS the streak the lane's own alert fires at, so the two cannot disagree", () => {
    expect(LANE_SILENT_MIN_STREAK).toBe(ZERO_PASS_STREAK_THRESHOLD);
    expect(LANE_SILENT_MIN_STREAK).toBe(6);
  });

  it("candidate-not-acting needs the plan's 20 actionable rows", () => {
    expect(CANDIDATE_NOT_ACTING_MIN_ACTIONABLE).toBe(20);
  });

  it("the sweep interval used to turn a streak into hours matches the real free-sweep cron", () => {
    expect(FREE_SWEEP_CRON).toBe(`*/${SWEEP_INTERVAL_MINUTES} * * * *`);
  });

  it("the adapter map covers exactly the adapters that exist, and every path exists in this checkout", () => {
    expect(Object.keys(ADAPTER_SOURCE_PATHS).sort()).toEqual(Object.keys(ADAPTERS).sort());
    for (const path of Object.values(ADAPTER_SOURCE_PATHS)) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
  });
});

describe("adapter-silent", () => {
  it("TRUE POSITIVE: one platform dead for 24h while the rest of the lane produces, its boards not failing", () => {
    const findings = findAdapterSilent(withSilent("ashby"), NOW);

    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f).toMatchObject({
      kind: "adapter-silent",
      severity: "high",
      location: "src/tools/jobhunt/adapters/ashby.ts",
    });
    expect(f!.subject.startsWith("ashby")).toBe(true);
    // Says what was measured, with the real numbers.
    expect(f!.evidence).toContain("ashby");
    expect(f!.evidence).toContain("100");
    expect(f!.evidence).toMatch(/0 .*24h|24h.* 0 /);
  });

  it("names the newest rows the platform DID yield, and every one of them was in the input", () => {
    const snapshot = withSilent("ashby");
    const [f] = findAdapterSilent(snapshot, NOW);

    const inputUrls = urlsIn(snapshot.newPostings);
    const rowsMentioningUrls = (f!.evidenceRows ?? []).flatMap((row) => row.match(/https?:\/\/\S+/g) ?? []);
    expect(rowsMentioningUrls.length).toBeGreaterThan(0);
    for (const url of rowsMentioningUrls) expect(inputUrls.has(url.replace(/[),.]+$/, ""))).toBe(true);
    // Only ashby rows are quoted as the platform's own history.
    for (const url of rowsMentioningUrls) expect(url).toContain("ashby");
  });

  it("TRUE NEGATIVE: a healthy lane produces nothing", () => {
    expect(findAdapterSilent(healthy(), NOW)).toEqual([]);
  });

  it("TRUE NEGATIVE: a platform with too little history is not judged (a natural gap is likely)", () => {
    const base = healthy();
    const thin = [
      ...base.newPostings.filter((p) => p.platform !== "ashby"),
      ...postings("ashby", ADAPTER_SILENT_MIN_BASELINE_ROWS - 1, { fromHoursAgo: 190, toHoursAgo: 26 }),
    ];
    expect(findAdapterSilent({ ...base, newPostings: thin }, NOW)).toEqual([]);
  });

  it("the baseline floor itself is judged (boundary is inclusive)", () => {
    const base = healthy();
    const exact = [
      ...base.newPostings.filter((p) => p.platform !== "ashby"),
      ...postings("ashby", ADAPTER_SILENT_MIN_BASELINE_ROWS, { fromHoursAgo: 190, toHoursAgo: 26 }),
    ];
    expect(findAdapterSilent({ ...base, newPostings: exact }, NOW)).toHaveLength(1);
  });

  it("TRUE NEGATIVE: one new row inside the window is not silence", () => {
    const snapshot = withSilent("ashby");
    const withOne = { ...snapshot, newPostings: [...snapshot.newPostings, ...postings("ashby", 1, { fromHoursAgo: 2, toHoursAgo: 2 })] };
    expect(findAdapterSilent(withOne, NOW)).toEqual([]);
  });

  it("TRUE NEGATIVE: when the WHOLE lane is quiet (weekend, holiday, dead sweep) no single platform is blamed", () => {
    const base = healthy();
    const allQuiet = base.newPostings.filter((p) => p.createdAt.getTime() <= NOW.getTime() - DAY);
    expect(findAdapterSilent({ ...base, newPostings: allQuiet }, NOW)).toEqual([]);
  });

  it("TRUE NEGATIVE: the rest of the lane running below the guard share is a quiet day, not a broken adapter", () => {
    const base = withSilent("ashby");
    // Others normally produce 100 baseline rows / 7 days each; leave them under MIN_LANE_SHARE of that in the window.
    const thinWindow = base.newPostings.filter(
      (p) => p.createdAt.getTime() <= NOW.getTime() - DAY || p.platform === "lever",
    );
    const keptOthersInWindow = thinWindow.filter((p) => p.createdAt.getTime() > NOW.getTime() - DAY).length;
    const perDay = (2 * 100) / 7; // greenhouse + lever baseline per day (ashby excluded)
    expect(keptOthersInWindow).toBeLessThan(ADAPTER_SILENT_MIN_LANE_SHARE * perDay);
    expect(findAdapterSilent({ ...base, newPostings: thinWindow }, NOW)).toEqual([]);
  });

  it("TRUE NEGATIVE: a platform rate-limited (429) in most sweeps is a fetch failure, not a broken parser", () => {
    const runs = sweepRuns(96, { platform: "ashby", runs: 80 });
    expect(80 / 96).toBeGreaterThan(ADAPTER_SILENT_MAX_FAILING_SWEEP_SHARE);
    expect(findAdapterSilent(withSilent("ashby", { ingestRuns: runs }), NOW)).toEqual([]);
  });

  it("a platform named in only a minority of failure summaries is still judged (one flaky board)", () => {
    const runs = sweepRuns(96, { platform: "ashby", runs: 10 });
    expect(findAdapterSilent(withSilent("ashby", { ingestRuns: runs }), NOW)).toHaveLength(1);
  });

  it("TRUE NEGATIVE: too few sweep runs in the window means the lane did not run, which is not the adapter's fault", () => {
    const runs = sweepRuns(ADAPTER_SILENT_MIN_SWEEP_RUNS - 1);
    expect(findAdapterSilent(withSilent("ashby", { ingestRuns: runs }), NOW)).toEqual([]);
  });

  it("rows an employer serves from its own domain (platform unknown) are not attributed to any platform", () => {
    const base = healthy();
    const ownDomain = postings(null, 300, { fromHoursAgo: 190, toHoursAgo: 26 });
    const snapshot = { ...base, newPostings: [...base.newPostings, ...ownDomain] };
    // Nothing on unknown-platform rows can produce a finding about a platform.
    expect(findAdapterSilent(snapshot, NOW)).toEqual([]);
  });

  it("empty input yields nothing rather than a finding computed from nothing", () => {
    expect(
      findAdapterSilent({ ingestRuns: [], laneHeartbeats: [], newPostings: [], applyActivity: [] }, NOW),
    ).toEqual([]);
  });

  it("keeps ONE identity for the whole silence, so a persistent defect files one issue (edge case: persists 10 days)", () => {
    const start = withSilent("ashby");
    // The same lane one and three days later: rows are already stored, only `now` moves.
    const laterRows = (from: Date): NewPostingRow[] => [
      ...start.newPostings.filter((p) => p.createdAt.getTime() <= NOW.getTime() - DAY),
      ...postings("greenhouse", 100, { fromHoursAgo: 23, toHoursAgo: 1 }, { from }),
      ...postings("lever", 100, { fromHoursAgo: 23, toHoursAgo: 1 }, { from }),
    ];
    const day1 = new Date(NOW.getTime() + DAY);
    const day3 = new Date(NOW.getTime() + 3 * DAY);
    const seenAtNow = findAdapterSilent(start, NOW)[0]!;
    const seenDay1 = findAdapterSilent({ ...start, newPostings: laterRows(day1), ingestRuns: sweepRuns(96, null, day1) }, day1)[0]!;
    const seenDay3 = findAdapterSilent({ ...start, newPostings: laterRows(day3), ingestRuns: sweepRuns(96, null, day3) }, day3)[0]!;

    // The rows moved through the window, so the numbers differ; the identity must not.
    expect(computeFingerprint(seenDay1)).toBe(computeFingerprint(seenAtNow));
    expect(computeFingerprint(seenDay3)).toBe(computeFingerprint(seenAtNow));
  });

  it("a NEW silence after a recovery is a new episode with a new identity", () => {
    const others = healthy().newPostings.filter((p) => p.platform !== "ashby");
    // Episode one: ashby's newest row is 50h old (2026-09-27).
    const firstEpisode = [...others, ...postings("ashby", 100, { fromHoursAgo: 190, toHoursAgo: 50 })];
    // Episode two: ashby came back and yielded rows up to 26h ago (2026-09-28), then went quiet again.
    const secondEpisode = [...firstEpisode, ...postings("ashby", 5, { fromHoursAgo: 30, toHoursAgo: 26 })];

    const first = findAdapterSilent({ ...healthy(), newPostings: firstEpisode }, NOW)[0]!;
    const second = findAdapterSilent({ ...healthy(), newPostings: secondEpisode }, NOW)[0]!;

    expect(first.subject).toContain("2026-09-27");
    expect(second.subject).toContain("2026-09-28");
    expect(computeFingerprint(second)).not.toBe(computeFingerprint(first));
  });

  it("does not mutate its input and is deterministic", () => {
    const snapshot = withSilent("ashby");
    const frozen = JSON.stringify(snapshot);
    const a = findAdapterSilent(snapshot, NOW);
    const b = findAdapterSilent(snapshot, NOW);
    expect(JSON.stringify(snapshot)).toBe(frozen);
    expect(a).toEqual(b);
  });
});

describe("failedPlatformsOf — reads the sweep's own failure summary", () => {
  it("returns every platform named in the real summariseFailures output", () => {
    const summary = summariseFailures([
      "greenhouse/foo: HTTP 404",
      "greenhouse/bar: HTTP 404",
      "ashby/x: HTTP 404",
      "recruitee/y: HTTP 429",
    ]);
    expect([...failedPlatformsOf(summary)].sort()).toEqual(["ashby", "greenhouse", "recruitee"]);
  });

  it("ignores segments it does not recognise, so a new summary format cannot make it throw or over-claim", () => {
    expect([...failedPlatformsOf("skipped 12 dead boards; greenhouse HTTP 404 ×2; +3 other pattern(s)")]).toEqual([
      "greenhouse",
    ]);
  });

  it("null and empty mean no failures", () => {
    expect(failedPlatformsOf(null).size).toBe(0);
    expect(failedPlatformsOf("").size).toBe(0);
  });
});

describe("apply-link-unrecognised", () => {
  const samples = (n: number, missing: number): NewPostingRow[] => [
    ...postings("smartrecruiters", missing, { fromHoursAgo: 120, toHoursAgo: 3 }, { hasFormLink: false }),
    ...postings("smartrecruiters", n - missing, { fromHoursAgo: 118, toHoursAgo: 2 }, { hasFormLink: true }),
  ];
  const snap = (rows: NewPostingRow[]): JobhuntSnapshot => ({ ...healthy(), newPostings: rows });

  it("TRUE POSITIVE: over 30% of one platform's rows have no form link", () => {
    const findings = findApplyLinkUnrecognised(snap(samples(40, 14)), NOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "apply-link-unrecognised",
      subject: "smartrecruiters",
      severity: "medium",
      location: "src/tools/jobhunt/board-token.ts",
    });
    expect(findings[0]!.evidence).toContain("14 of 40");
    expect(findings[0]!.evidence).toContain("35%");
  });

  it("TRUE NEGATIVE: exactly 30% is not over 30%", () => {
    expect(findApplyLinkUnrecognised(snap(samples(40, 12)), NOW)).toEqual([]);
  });

  it("TRUE NEGATIVE: a healthy recogniser (no missing links) produces nothing", () => {
    expect(findApplyLinkUnrecognised(snap(samples(40, 0)), NOW)).toEqual([]);
  });

  it("TRUE NEGATIVE: too small a sample cannot file an issue over one odd URL", () => {
    expect(findApplyLinkUnrecognised(snap(samples(APPLY_LINK_MIN_ROWS - 1, APPLY_LINK_MIN_ROWS - 1)), NOW)).toEqual([]);
  });

  it("TRUE NEGATIVE: employer-domain postings (white-labelled boards) are by design and never counted", () => {
    // 17.8% of the 2026-09-28 sweep had no form link by design; at scale the share
    // of own-domain rows is far above 30% and must not read as a recogniser bug.
    const own = postings(null, 200, { fromHoursAgo: 100, toHoursAgo: 1 }, { hasFormLink: false });
    expect(findApplyLinkUnrecognised(snap(own), NOW)).toEqual([]);
  });

  it("only looks at the last 7 days", () => {
    const old = postings("smartrecruiters", 40, { fromHoursAgo: 300, toHoursAgo: 200 }, { hasFormLink: false });
    expect(findApplyLinkUnrecognised(snap(old), NOW)).toEqual([]);
  });

  it("quotes only rows that lack the link, and only rows that were in the input", () => {
    const rows = samples(40, 14);
    const [f] = findApplyLinkUnrecognised(snap(rows), NOW);
    const missingUrls = urlsIn(rows.filter((r) => !r.hasFormLink));
    const quoted = (f!.evidenceRows ?? []).flatMap((row) => row.match(/https?:\/\/\S+/g) ?? []);
    expect(quoted.length).toBeGreaterThan(0);
    for (const url of quoted) expect(missingUrls.has(url.replace(/[),.]+$/, ""))).toBe(true);
  });

  it("empty input yields nothing", () => {
    expect(findApplyLinkUnrecognised({ ingestRuns: [], laneHeartbeats: [], newPostings: [], applyActivity: [] }, NOW)).toEqual([]);
  });
});

describe("lane-silent (a DECISION, Telegram only)", () => {
  const beat = (streak: number, over: Partial<LaneHeartbeatRow> = {}): LaneHeartbeatRow => ({
    profileId: "wife-nl-finance",
    candidateName: "Tashi Goyal",
    zeroPassStreak: streak,
    lastFunnel: null,
    ...over,
  });

  it("TRUE POSITIVE: streak at the threshold", () => {
    const [f] = findLaneSilent({ ...healthy(), laneHeartbeats: [beat(LANE_SILENT_MIN_STREAK)] });
    expect(f).toMatchObject({ kind: "lane-silent", subject: "wife-nl-finance" });
    expect(f!.evidence).toContain("Tashi Goyal");
    expect(f!.evidence).toContain(String(LANE_SILENT_MIN_STREAK));
  });

  it("TRUE NEGATIVE: one short of the threshold", () => {
    expect(findLaneSilent({ ...healthy(), laneHeartbeats: [beat(LANE_SILENT_MIN_STREAK - 1)] })).toEqual([]);
  });

  it("turns the streak into hours using the real sweep interval", () => {
    const [f] = findLaneSilent({ ...healthy(), laneHeartbeats: [beat(60)] });
    expect(f!.evidence).toContain("30 hours");
  });

  it("names the stage the last survivors died at when the funnel is known", () => {
    const funnel = { seen: 900, undated: 0, stale: 0, offTrack: 0, offMarket: 0, known: 900, bodyless: 0, screened: 0 };
    const [f] = findLaneSilent({ ...healthy(), laneHeartbeats: [beat(8, { lastFunnel: funnel })] });
    expect(f!.evidence).toContain("already known in tracker");
  });

  it("never asks for an issue: it is not an implementation kind", () => {
    const [f] = findLaneSilent({ ...healthy(), laneHeartbeats: [beat(12)] });
    expect(f!.location).toBeUndefined();
    expect(f!.evidenceRows).toBeUndefined();
  });
});

describe("candidate-not-acting (a DECISION, Telegram only)", () => {
  const activity = (over: Partial<ApplyActivityRow> = {}): ApplyActivityRow => ({
    profileId: "wife-nl-finance",
    candidateName: "Tashi Goyal",
    doToday: 28,
    stretch: 14,
    ask: 20,
    applied: 0,
    skipped: 0,
    ...over,
  });

  it("TRUE POSITIVE: the founder's measured case, 62 actionable rows and nothing applied", () => {
    const [f] = findCandidateNotActing({ ...healthy(), applyActivity: [activity()] });
    expect(f).toMatchObject({ kind: "candidate-not-acting", subject: "wife-nl-finance", severity: "high" });
    expect(f!.evidence).toContain("62");
    expect(f!.evidence).toContain("28 do today");
    expect(f!.evidence).toContain("0 applied");
  });

  it("says nothing shows she has seen them when nothing was skipped either", () => {
    const [f] = findCandidateNotActing({ ...healthy(), applyActivity: [activity()] });
    expect(f!.evidence).toMatch(/not opening|has seen/i);
  });

  it("tells a reader-who-passes apart from a reader-who-never-looked when rows were skipped", () => {
    const [f] = findCandidateNotActing({ ...healthy(), applyActivity: [activity({ skipped: 31 })] });
    expect(f!.evidence).toContain("31 skipped");
    expect(f!.evidence).toMatch(/read|passing|screening/i);
  });

  it("TRUE NEGATIVE: exactly one application in the window is acting", () => {
    expect(findCandidateNotActing({ ...healthy(), applyActivity: [activity({ applied: 1 })] })).toEqual([]);
  });

  it("TRUE NEGATIVE: one short of the actionable floor", () => {
    expect(
      findCandidateNotActing({
        ...healthy(),
        applyActivity: [activity({ doToday: 10, stretch: 5, ask: CANDIDATE_NOT_ACTING_MIN_ACTIONABLE - 15 - 1 })],
      }),
    ).toEqual([]);
  });

  it("the floor itself fires (boundary is inclusive)", () => {
    expect(
      findCandidateNotActing({
        ...healthy(),
        applyActivity: [activity({ doToday: 10, stretch: 5, ask: CANDIDATE_NOT_ACTING_MIN_ACTIONABLE - 15 })],
      }),
    ).toHaveLength(1);
  });

  it("judges each profile on its own numbers", () => {
    const found = findCandidateNotActing({
      ...healthy(),
      applyActivity: [activity(), activity({ profileId: "pushkar-nl-tech", candidateName: "Pushkar", applied: 3 })],
    });
    expect(found.map((f) => f.subject)).toEqual(["wife-nl-finance"]);
  });

  it("ignores a row whose counts are not finite numbers instead of guessing", () => {
    expect(
      findCandidateNotActing({ ...healthy(), applyActivity: [activity({ doToday: Number.NaN })] }),
    ).toEqual([]);
  });
});

describe("analyzeJobhunt — the four checks together", () => {
  it("returns findings ranked so the implementation kind an issue would be filed for comes first", () => {
    const snapshot = withSilent("ashby", {
      laneHeartbeats: [{ profileId: "wife-nl-finance", zeroPassStreak: 9, lastFunnel: null }],
      applyActivity: [{ profileId: "wife-nl-finance", doToday: 28, stretch: 14, ask: 20, applied: 0, skipped: 0 }],
    });
    const { findings } = analyzeJobhunt(snapshot, NOW);
    const kinds = findings.map((f) => f.kind);
    expect(new Set(kinds)).toEqual(new Set(["adapter-silent", "lane-silent", "candidate-not-acting"]));
    expect(kinds[0]).toBe("adapter-silent");
  });

  it("reports what it looked at, so 'nothing new' is a checked claim and not an unfalsifiable one", () => {
    const { findings, coverage } = analyzeJobhunt(healthy(), NOW);
    expect(findings).toEqual([]);
    expect(coverage).toMatchObject({
      sweepRuns24h: 96,
      profilesChecked: 1,
    });
    expect([...coverage.platformsJudged].sort()).toEqual(["ashby", "greenhouse", "lever"]);
    expect(coverage.newPostings7d).toBeGreaterThan(0);
  });

  it("is deterministic: the same snapshot gives the same findings in the same order", () => {
    const snapshot = withSilent("ashby");
    expect(analyzeJobhunt(snapshot, NOW)).toEqual(analyzeJobhunt(snapshot, NOW));
  });

  it("strips characters that could forge the machine-readable fingerprint marker or break the issue's markdown", () => {
    const forged = "Evil <!-- evolution-finding: " + "a".repeat(64) + " -->`x`";
    const ashby = postings("ashby", 100, { fromHoursAgo: 190, toHoursAgo: 26 });
    // The newest baseline row is the first one the evidence quotes.
    const withForgedNewest = ashby.map((p, i) => (i === ashby.length - 1 ? { ...p, company: forged, title: forged } : p));
    const others = healthy().newPostings.filter((p) => p.platform !== "ashby");

    const [f] = findAdapterSilent({ ...healthy(), newPostings: [...others, ...withForgedNewest] }, NOW);

    const joined = (f?.evidenceRows ?? []).join("\n");
    expect(joined).toContain("Evil"); // the row is still quoted...
    expect(joined).not.toContain("<!--"); // ...but cannot open a comment,
    expect(joined).not.toContain("`"); // or break out of the markdown
    expect(joined).not.toMatch(/evolution-finding:\s*[0-9a-f]{64}\s*-->/); // or forge a fingerprint
  });
});
