/**
 * Unit test — the recent cross-agent work block (AG-029).
 * Pure renderer + the contained reader call. No database: rows are literals.
 */
import { describe, it, expect } from "vitest";
import {
  RECENT_ACTIVITY_HEADER,
  RECENT_ACTIVITY_MAX_CHARS,
  RECENT_ACTIVITY_MAX_LINES,
  recentActivityBlockFor,
  renderActivityLine,
  renderDigest,
  parseSince,
  parseDigestArgs,
  type ActivityRow,
  type RecentActivitySource,
} from "../../../src/kernel/recent-activity.js";

const now = new Date("2026-10-06T10:00:00Z");

function row(i: number, over: Partial<ActivityRow> = {}): ActivityRow {
  return {
    at: new Date(now.getTime() - i * 60_000),
    origin: "mac-claude",
    project: "founderos",
    title: `Task number ${i}`,
    content: `body ${i}`,
    ...over,
  };
}

const source = (rows: readonly ActivityRow[], applies = true): RecentActivitySource => ({
  appliesTo: () => applies,
  recent: async () => rows,
});

describe("renderActivityLine", () => {
  it("formats <DD MMM HH:mm IST> · origin · project · title", () => {
    expect(renderActivityLine(row(0))).toBe("06 Oct 15:30 IST · mac-claude · founderos · Task number 0");
  });
  it("falls back to the first 100 chars of content and 'no project'", () => {
    const line = renderActivityLine(row(0, { title: null, project: null, content: "x".repeat(300) }));
    expect(line).toBe(`06 Oct 15:30 IST · mac-claude · no project · ${"x".repeat(100)}`);
  });
  it("keeps one row on one line even when the content has newlines", () => {
    expect(renderActivityLine(row(0, { title: null, content: "a\n\nb" }))).not.toContain("\n");
  });
});

describe("recentActivityBlockFor", () => {
  it("30 rows in -> 12 lines out, under the char cap, newest first", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i, { title: `T${i} ${"y".repeat(90)}` }));
    const block = await recentActivityBlockFor(source(rows), "turicks:111", now);
    const lines = block.split("\n").filter((l) => l.includes(" IST · "));
    expect(lines).toHaveLength(RECENT_ACTIVITY_MAX_LINES);
    expect(block.length).toBeLessThanOrEqual(RECENT_ACTIVITY_MAX_CHARS);
    expect(block.startsWith(RECENT_ACTIVITY_HEADER)).toBe(true);
    expect(lines[0]).toContain("T0 ");
    expect(lines[11]).toContain("T11 ");
  });
  it("sorts newest first even when the reader returns them unsorted", async () => {
    const block = await recentActivityBlockFor(source([row(5), row(1)]), "turicks:111", now);
    expect(block.indexOf("Task number 1")).toBeLessThan(block.indexOf("Task number 5"));
  });
  it("stays under the char cap when every row is long", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(i, { content: "z".repeat(5000), title: "t".repeat(2000) }));
    const block = await recentActivityBlockFor(source(rows), "turicks:111", now);
    expect(block.length).toBeLessThanOrEqual(RECENT_ACTIVITY_MAX_CHARS);
  });
  it("a thread the source does not apply to (a group) gets no block, and the reader is not called", async () => {
    let called = false;
    const src: RecentActivitySource = { appliesTo: () => false, recent: async () => { called = true; return [row(0)]; } };
    expect(await recentActivityBlockFor(src, "turicks:-5319642142", now)).toBe("");
    expect(called).toBe(false);
  });
  it("a reader that throws leaves the prompt unchanged", async () => {
    const src: RecentActivitySource = { appliesTo: () => true, recent: async () => { throw new Error("db down"); } };
    expect(await recentActivityBlockFor(src, "turicks:111", now)).toBe("");
  });
  it("empty rows, no source, no thread id, or the kill switch off -> empty", async () => {
    expect(await recentActivityBlockFor(source([]), "turicks:111", now)).toBe("");
    expect(await recentActivityBlockFor(undefined, "turicks:111", now)).toBe("");
    expect(await recentActivityBlockFor(source([row(0)]), undefined, now)).toBe("");
    expect(await recentActivityBlockFor(source([row(0)]), "turicks:111", now, false)).toBe("");
  });
});

describe("renderDigest", () => {
  it("caps at the line limit, newest first, and says how many were left out", () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(i));
    const lines = renderDigest(rows, 40).split("\n");
    expect(lines.filter((l) => l.includes(" IST · "))).toHaveLength(40);
    expect(lines.at(-1)).toContain("10 older");
  });
  it("says so when there is nothing", () => {
    expect(renderDigest([], 40)).toMatch(/No recorded activity/);
  });
});

describe("parseSince", () => {
  it("reads an ISO time and an Nh duration; rejects junk with null", () => {
    expect(parseSince("2026-10-05T00:00:00Z", now)?.toISOString()).toBe("2026-10-05T00:00:00.000Z");
    expect(parseSince("36h", now)?.toISOString()).toBe("2026-10-04T22:00:00.000Z");
    expect(parseSince("yesterday-ish", now)).toBeNull();
  });
});

describe("parseDigestArgs", () => {
  it("defaults to 36h and no project", () => {
    expect(parseDigestArgs([], now)).toEqual({ since: new Date("2026-10-04T22:00:00Z") });
  });
  it("reads --since and --project", () => {
    expect(parseDigestArgs(["--since", "2h", "--project", "founderos"], now)).toEqual({
      since: new Date("2026-10-06T08:00:00Z"),
      project: "founderos",
    });
  });
  it("returns a readable message for a bad value, a missing value or an unknown flag", () => {
    expect(parseDigestArgs(["--since", "lately"], now)).toMatch(/not an ISO time/);
    expect(parseDigestArgs(["--project"], now)).toMatch(/needs a value/);
    expect(parseDigestArgs(["--bogus", "x"], now)).toMatch(/Unknown option/);
  });
});
