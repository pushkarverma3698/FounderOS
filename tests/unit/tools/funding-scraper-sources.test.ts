/**
 * The funding-news sources the registry grower actually reads.
 *
 * Two of the four were dead on 2026-09-07 and had been for days: Inc42's
 * `/buzz/funding-alert/` returned 404 (the section was retired) and
 * EU-Startups' `/category/funding/` returned 403 to every user-agent tried,
 * browser headers included. `scrapeFundingSource` is fail-open by design, so
 * both logged a warning and returned `[]` — the whole night's discovery ran on
 * half its inputs and reported success. That is the right behaviour for one
 * flaky fetch and the wrong one for a permanently dead URL, and nothing in the
 * loop could tell those apart.
 *
 * These tests cannot reach the network (the unit suite is offline and $0), so
 * they pin what a unit test CAN pin: the dead paths are gone, and the RSS
 * pattern that replaced the blocked HTML page extracts titles correctly. The
 * live 200s were confirmed by hand on 2026-09-08 and recorded in the source's
 * own comments.
 */

import { describe, it, expect } from "vitest";
import {
  FUNDING_SOURCES,
  RSS_TITLE_PATTERN,
  scrapeFundingSource,
} from "../../../src/tools/jobhunt/funding-scraper.js";

/** A feed shaped like the ones EU-Startups and Silicon Canals actually serve. */
const FEED = `<?xml version="1.0"?><rss><channel>
  <title>Site feed</title>
  <item><title><![CDATA[Stockholm-based Fluencify raises €2M to scale]]></title></item>
  <item><title>Molten Ventures secures £85M for its growth fund</title></item>
  <item><title>Some unrelated opinion piece about hiring</title></item>
</channel></rss>`;

describe("FUNDING_SOURCES", () => {
  it("no longer points at Inc42's retired funding-alert section", () => {
    const inc42 = FUNDING_SOURCES.find((s) => s.name === "Inc42");
    expect(inc42).toBeDefined();
    expect(inc42!.url).not.toContain("funding-alert");
  });

  it("no longer points at the EU-Startups category page that answers 403", () => {
    const eu = FUNDING_SOURCES.find((s) => s.name === "EU-Startups");
    expect(eu).toBeDefined();
    expect(eu!.url).not.toContain("/category/funding");
  });

  it("keeps all four sources — the fix repoints them, it does not drop them", () => {
    expect(FUNDING_SOURCES.map((s) => s.name).sort()).toEqual([
      "EU-Startups",
      "Inc42",
      "Silicon Canals",
      "YourStory",
    ]);
  });

  it("covers both markets", () => {
    expect(new Set(FUNDING_SOURCES.map((s) => s.market))).toEqual(new Set(["IN", "NL"]));
  });
});

describe("RSS_TITLE_PATTERN", () => {
  it("extracts a CDATA-wrapped title", () => {
    RSS_TITLE_PATTERN.lastIndex = 0;
    const titles = [...FEED.matchAll(RSS_TITLE_PATTERN)].map((m) => m[1]);
    expect(titles[0]).toContain("Fluencify raises");
  });

  it("extracts a plain title", () => {
    RSS_TITLE_PATTERN.lastIndex = 0;
    const titles = [...FEED.matchAll(RSS_TITLE_PATTERN)].map((m) => m[1]);
    expect(titles[1]).toContain("Molten Ventures secures");
  });

  it("ignores the channel title — only <item> titles are headlines", () => {
    RSS_TITLE_PATTERN.lastIndex = 0;
    const titles = [...FEED.matchAll(RSS_TITLE_PATTERN)].map((m) => m[1]);
    expect(titles).toHaveLength(3);
    expect(titles).not.toContain("Site feed");
  });
});

describe("scrapeFundingSource over a feed", () => {
  it("turns feed items into company signals and skips non-funding headlines", async () => {
    const eu = FUNDING_SOURCES.find((s) => s.name === "EU-Startups")!;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(FEED, { status: 200, headers: { "content-type": "application/rss+xml" } })) as typeof fetch;
    try {
      const signals = await scrapeFundingSource(eu);
      const companies = signals.map((s) => s.company);
      expect(companies.some((c) => c.includes("Fluencify"))).toBe(true);
      expect(companies.some((c) => c.includes("Molten Ventures"))).toBe(true);
      expect(companies.some((c) => c.includes("opinion piece"))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
