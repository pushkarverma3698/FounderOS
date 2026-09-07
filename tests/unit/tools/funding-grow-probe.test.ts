/**
 * Which ATS platforms the funding grower can probe from a company NAME.
 *
 * WHAT BROKE (prod, nightly, at least 2026-09-03 → 09-07 inclusive).
 * `scripts/jobhunt-funding-grow.ts` turns a funding-news headline into a bare
 * slug ("oxfordquantumcircuitsjust") and probes every platform in
 * FREE_ATS_PLATFORMS with it. Workday's board URL needs three coordinates —
 * `<tenant>/<wdN>/<site>` — so `boardUrl()` THREW on the first such token, and
 * the throw happened inside the mapper passed to `mapWithConcurrencyLimit`,
 * under a `Promise.all` over all ten hosts. One unparseable name therefore
 * aborted the entire night's batch, discarding every other company discovered
 * that night. The scheduler spawned the child with `stdio: "ignore"`, so all
 * production ever recorded was `{"code":1}` — four identical nights with no
 * detail, and a fully dead discovery channel that emitted no signal.
 *
 * Two independent guards, because either alone leaves the failure available:
 *   1. Don't probe a platform whose token cannot be derived from a name.
 *   2. If any probe throws anyway, contain it to that token.
 * The second test is the one that keeps mattering: it fails the day someone
 * adds a new compound-token adapter to the discovery list.
 */

import { describe, it, expect } from "vitest";
import {
  FREE_ATS_PLATFORMS,
  NAME_DERIVABLE_ATS,
} from "../../../src/tools/jobhunt/free-boards.js";
import { boardUrl } from "../../../src/tools/jobhunt/free-ats-source.js";

/** What a funding headline actually normalises to — one slug, no separators. */
const BARE_SLUG = "oxfordquantumcircuitsjust";

describe("NAME_DERIVABLE_ATS", () => {
  it("excludes workday, whose token is three coordinates a company name cannot supply", () => {
    expect(FREE_ATS_PLATFORMS).toContain("workday");
    expect(NAME_DERIVABLE_ATS).not.toContain("workday");
  });

  it("keeps every other configured platform — the fix must not shrink discovery", () => {
    const dropped = FREE_ATS_PLATFORMS.filter((a) => !NAME_DERIVABLE_ATS.includes(a));
    expect(dropped).toEqual(["workday"]);
  });

  it("is a subset of the configured platforms, never a source of new ones", () => {
    for (const ats of NAME_DERIVABLE_ATS) expect(FREE_ATS_PLATFORMS).toContain(ats);
  });

  it("EVERY member builds a board URL from a bare slug without throwing", () => {
    for (const ats of NAME_DERIVABLE_ATS) {
      expect(() => boardUrl({ name: BARE_SLUG, ats, token: BARE_SLUG, markets: [] })).not.toThrow();
    }
  });

  it("the excluded platform is excluded for the stated reason, not by taste", () => {
    // Pins the actual asymmetry: workday is the one that throws here.
    expect(() =>
      boardUrl({ name: BARE_SLUG, ats: "workday", token: BARE_SLUG, markets: [] }),
    ).toThrow(/tenant/);
  });
});
