/**
 * Unit tests for the PURE half of ui_check: facts → defects.
 *
 * No browser, no network, no model. Fixtures only (STANDARDS §9), which is the
 * point of splitting the analyzer out of the collector: the judgement logic is
 * testable at $0 and in milliseconds.
 */

import { describe, it, expect } from "vitest";
import {
  analyzePageFacts,
  rowIsOk,
  assetSeverity,
  dedupeAssets,
  BLANK_PAGE_MIN_CHARS,
  OVERFLOW_TOLERANCE_PX,
  type PageFacts,
} from "../../../../src/tools/browser/ui-analyze.js";

/** A page with nothing wrong with it. Each test perturbs exactly one field. */
function healthyFacts(over: Partial<PageFacts> = {}): PageFacts {
  return {
    target: "neon",
    url: "/assets/cinematic-presets/neon/index.html",
    viewport: "desktop",
    title: "Acme Robotics — Cinematic Launch",
    bodyText:
      "Acme Robotics. Replace this subhead with your product promise. Why teams choose Acme Robotics. Feature one, feature two, feature three.",
    consoleErrors: [],
    pageErrors: [],
    failedAssets: [],
    scrollWidth: 1440,
    clientWidth: 1440,
    emptyBlocks: [],
    brokenImages: [],
    headingCount: 2,
    h1Count: 1,
    ...over,
  };
}

describe("analyzePageFacts — the healthy baseline", () => {
  it("reports no defects for a well-rendered page", () => {
    expect(analyzePageFacts(healthyFacts())).toEqual([]);
  });

  it("treats a clean page as a passing row", () => {
    expect(rowIsOk(analyzePageFacts(healthyFacts()))).toBe(true);
  });
});

describe("analyzePageFacts — unsubstituted placeholders", () => {
  it("flags a placeholder left in the body as HIGH", () => {
    const defects = analyzePageFacts(
      healthyFacts({ bodyText: "Welcome to {{TAGLINE}} — the future of robotics, built for teams everywhere." }),
    );
    const found = defects.find((d) => d.kind === "unsubstituted-placeholder");
    expect(found?.severity).toBe("high");
    expect(found?.detail).toContain("{{TAGLINE}}");
    expect(rowIsOk(defects)).toBe(false);
  });

  it("flags a placeholder left in the <title>", () => {
    const defects = analyzePageFacts(healthyFacts({ title: "{{CLIENT}} — Launch" }));
    expect(defects.some((d) => d.kind === "unsubstituted-placeholder")).toBe(true);
  });

  it("deduplicates a placeholder that appears many times", () => {
    const defects = analyzePageFacts(
      healthyFacts({ bodyText: "{{CLIENT}} builds robots. {{CLIENT}} ships fast. Choose {{CLIENT}} today for everything." }),
    );
    const found = defects.filter((d) => d.kind === "unsubstituted-placeholder");
    expect(found).toHaveLength(1);
    expect(found[0]?.detail).toContain("1 template placeholder");
  });

  it("does NOT flag a page whose placeholders were correctly substituted", () => {
    // The true negative that matters: apply_cinematic_preset filled {{CLIENT}},
    // so a healthy preset must not trip the gate on every run.
    const defects = analyzePageFacts(healthyFacts({ bodyText: "Acme Robotics builds robots for teams everywhere." }));
    expect(defects.some((d) => d.kind === "unsubstituted-placeholder")).toBe(false);
  });

  it("does not mistake ordinary braces for a placeholder", () => {
    const defects = analyzePageFacts(
      healthyFacts({ bodyText: "Our config looks like { alpha: 1 } and our set is {a, b} across the board." }),
    );
    expect(defects.some((d) => d.kind === "unsubstituted-placeholder")).toBe(false);
  });
});

describe("analyzePageFacts — asset and script failures", () => {
  it("treats a missing stylesheet as HIGH", () => {
    const defects = analyzePageFacts(
      healthyFacts({ failedAssets: [{ url: "https://x.test/styles.css", reason: "HTTP 404" }] }),
    );
    const found = defects.find((d) => d.kind === "failed-asset");
    expect(found?.severity).toBe("high");
    expect(found?.detail).toContain("unstyled");
  });

  it("treats a missing image as MEDIUM, not blocking", () => {
    const defects = analyzePageFacts(
      healthyFacts({ failedAssets: [{ url: "https://x.test/hero.png", reason: "HTTP 404" }] }),
    );
    expect(defects.find((d) => d.kind === "failed-asset")?.severity).toBe("medium");
    expect(rowIsOk(defects)).toBe(true);
  });

  it("classifies asset severity by extension", () => {
    expect(assetSeverity("/a/styles.css")).toBe("high");
    expect(assetSeverity("/a/app.js?v=2")).toBe("high");
    expect(assetSeverity("/a/photo.png")).toBe("medium");
  });

  it("treats an uncaught page error as HIGH and a console error as MEDIUM", () => {
    const defects = analyzePageFacts(
      healthyFacts({ pageErrors: ["ReferenceError: gsap is not defined"], consoleErrors: ["favicon 404"] }),
    );
    expect(defects.find((d) => d.kind === "page-error")?.severity).toBe("high");
    expect(defects.find((d) => d.kind === "console-error")?.severity).toBe("medium");
  });
});

describe("analyzePageFacts — layout and content", () => {
  it("flags a blank page as HIGH", () => {
    const defects = analyzePageFacts(healthyFacts({ bodyText: "   " }));
    const found = defects.find((d) => d.kind === "blank-page");
    expect(found?.severity).toBe("high");
    expect(found?.detail).toContain(String(BLANK_PAGE_MIN_CHARS));
  });

  it("ignores sub-pixel overflow within tolerance", () => {
    const defects = analyzePageFacts(
      healthyFacts({ scrollWidth: 1440 + OVERFLOW_TOLERANCE_PX, clientWidth: 1440 }),
    );
    expect(defects.some((d) => d.kind === "horizontal-overflow")).toBe(false);
  });

  it("flags real horizontal overflow and states the measurement", () => {
    const defects = analyzePageFacts(healthyFacts({ scrollWidth: 1600, clientWidth: 1440 }));
    const found = defects.find((d) => d.kind === "horizontal-overflow");
    expect(found?.detail).toContain("160px");
    expect(found?.detail).toContain("desktop");
  });

  it("flags an invisible section, a broken image, a missing title and a page with no headings", () => {
    const defects = analyzePageFacts(
      healthyFacts({ emptyBlocks: ["section"], brokenImages: ["/hero.png"], title: "", headingCount: 0, h1Count: 0 }),
    );
    const kinds = defects.map((d) => d.kind);
    expect(kinds).toContain("empty-section");
    expect(kinds).toContain("broken-image");
    expect(kinds).toContain("missing-title");
    expect(kinds).toContain("no-headings");
    // None of these alone should block a merge.
    expect(rowIsOk(defects)).toBe(true);
  });
});

describe("analyzePageFacts — legibility contract (rule #26)", () => {
  it("states a measurement and its value in every detail, never a bare label", () => {
    const defects = analyzePageFacts(
      healthyFacts({
        bodyText: "{{TAGLINE}}",
        scrollWidth: 1600,
        clientWidth: 1440,
        failedAssets: [{ url: "/styles.css", reason: "HTTP 404" }],
      }),
    );
    expect(defects.length).toBeGreaterThan(0);
    for (const d of defects) {
      // A detail must be a sentence a non-coder can act on, not an internal slug.
      expect(d.detail.length).toBeGreaterThan(40);
      expect(d.detail).not.toBe(d.kind);
    }
  });
});

describe("analyzePageFacts — one failure, one report", () => {
  it("reports a single missing stylesheet once, not once per browser event", () => {
    // Playwright emits BOTH an HTTP 404 (response) and a net::ERR_ABORTED
    // (requestfailed) for one failed request. Reported twice, a single missing
    // stylesheet inflates the blocking count and reads as two problems.
    const defects = analyzePageFacts(
      healthyFacts({
        failedAssets: [
          { url: "http://127.0.0.1:41111/styles-v2.css", reason: "HTTP 404" },
          { url: "http://127.0.0.1:41111/styles-v2.css", reason: "net::ERR_ABORTED" },
        ],
      }),
    );
    const assetDefects = defects.filter((d) => d.kind === "failed-asset");
    expect(assetDefects).toHaveLength(1);
    // The HTTP status is kept — it says more than the abort that follows it.
    expect(assetDefects[0]?.detail).toContain("HTTP 404");
  });

  it("still reports two genuinely different failed assets separately", () => {
    const defects = analyzePageFacts(
      healthyFacts({
        failedAssets: [
          { url: "/styles.css", reason: "HTTP 404" },
          { url: "/app.js", reason: "HTTP 500" },
        ],
      }),
    );
    expect(defects.filter((d) => d.kind === "failed-asset")).toHaveLength(2);
  });

  it("dedupeAssets keeps the first reason per URL", () => {
    expect(dedupeAssets([
      { url: "/a.css", reason: "HTTP 404" },
      { url: "/a.css", reason: "net::ERR_ABORTED" },
      { url: "/b.css", reason: "HTTP 500" },
    ])).toEqual([
      { url: "/a.css", reason: "HTTP 404" },
      { url: "/b.css", reason: "HTTP 500" },
    ]);
  });
});

describe("analyzePageFacts — the main headline", () => {
  it("flags a page that kept its <h2>s but lost its <h1>", () => {
    // headingCount alone misses this: deleting the <h1> from a preset leaves the
    // <h2> behind, so "has headings" stays true while the headline is gone.
    const defects = analyzePageFacts(healthyFacts({ headingCount: 1, h1Count: 0 }));
    const found = defects.find((d) => d.kind === "missing-h1");
    expect(found?.severity).toBe("medium");
    expect(found?.detail).toContain("no <h1>");
  });

  it("does not flag a healthy page with exactly one <h1>", () => {
    expect(analyzePageFacts(healthyFacts()).some((d) => d.kind === "missing-h1")).toBe(false);
  });

  it("flags multiple <h1> elements as a low-severity blemish", () => {
    const found = analyzePageFacts(healthyFacts({ h1Count: 3 })).find((d) => d.kind === "missing-h1");
    expect(found?.severity).toBe("low");
  });

  it("prefers the no-headings message when there are no headings at all", () => {
    const kinds = analyzePageFacts(healthyFacts({ headingCount: 0, h1Count: 0 })).map((d) => d.kind);
    expect(kinds).toContain("no-headings");
    expect(kinds).not.toContain("missing-h1");
  });
});
