/**
 * The register loader is the gate's data supply. These tests pin the two ways it
 * can silently ruin the campaign: mis-parsing quoted names (114 register entries
 * contain commas inside quotes) and returning an empty index, which would mark
 * every company `not-sponsor` and reject the entire reachable market.
 */

import { describe, test, expect, beforeEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCsvLine,
  parseSponsorCsv,
  getSponsorIndex,
  resetSponsorIndexCache,
  resolveRepoRoot,
  registerPathFrom,
  SPONSOR_REGISTER_PATH,
} from "../../../src/tools/jobhunt/sponsor-registry.js";
import { matchSponsor } from "../../../src/tools/jobhunt/sponsor-match.js";

beforeEach(() => {
  resetSponsorIndexCache();
});

describe("parseCsvLine", () => {
  test("splits a plain unquoted row", () => {
    expect(parseCsvLine("Adyen N.V.,34259528")).toEqual(["Adyen N.V.", "34259528"]);
  });

  test("keeps commas that live inside a quoted field", () => {
    // Arrange — the real shape of the 114 quoted register rows.
    const line = '"AirLife Netherlands Holdings, B.V.",90558014';

    // Act
    const fields = parseCsvLine(line);

    // Assert — a naive split would produce three fields and corrupt the name.
    expect(fields).toEqual(["AirLife Netherlands Holdings, B.V.", "90558014"]);
  });

  test("unescapes a doubled quote inside a quoted field", () => {
    expect(parseCsvLine('"The ""Big"" Co",123')).toEqual(['The "Big" Co', "123"]);
  });
});

describe("parseSponsorCsv", () => {
  test("drops the header row and returns names only", () => {
    const csv = "name,kvk\nAdyen N.V.,34259528\nBooking.com B.V.,31047344\n";
    expect(parseSponsorCsv(csv)).toEqual(["Adyen N.V.", "Booking.com B.V."]);
  });

  test("keeps the first row when the file has no header", () => {
    expect(parseSponsorCsv("Adyen N.V.,34259528\n")).toEqual(["Adyen N.V."]);
  });

  test("returns empty for an empty file rather than a bogus entry", () => {
    expect(parseSponsorCsv("")).toEqual([]);
    expect(parseSponsorCsv("\n\n")).toEqual([]);
  });
});

describe("getSponsorIndex", () => {
  test("loads the real register with every row indexed", () => {
    // Arrange — count the data rows on disk independently of the loader.
    const rawRows = readFileSync(SPONSOR_REGISTER_PATH, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0).length - 1;

    // Act
    const index = getSponsorIndex();

    // Assert — normalisation collapses a few duplicates, so allow shrinkage but
    // not the order-of-magnitude loss a parser bug would cause.
    expect(rawRows).toBeGreaterThan(12_000);
    expect(index.size).toBeGreaterThan(rawRows * 0.95);
  });

  test("caches the index across calls", () => {
    expect(getSponsorIndex()).toBe(getSponsorIndex());
  });

  test("a known recognised sponsor matches exactly", () => {
    const match = matchSponsor("Adyen N.V.", getSponsorIndex());
    expect(match.verdict).toBe("sponsor");
  });

  test("a company that is not on the register is rejected, not flagged", () => {
    const match = matchSponsor("Zzyzx Widgetworks", getSponsorIndex());
    expect(match.verdict).toBe("not-sponsor");
  });
});

/**
 * The register path must resolve from the BUILT layout, not just the source one.
 *
 * This is the regression guard for the 2026-08-02 outage. The loader counted
 * three directories up from its own file, which is right for
 * `src/tools/jobhunt/…` and wrong for what tsc actually emits: `tsconfig.json`
 * sets no `rootDir` and includes both `src/**` and `scripts/**`, so the common
 * root is the repo and the output lands at `dist/src/tools/jobhunt/…` — four
 * deep. In production the path became `<repo>/dist/docs/…`, which does not
 * exist, so `getSponsorRegister()` threw ENOENT on EVERY posting and the whole
 * sweep resolved to `outcome: "error"`.
 *
 * Every one of these tests passed throughout, because `tsx` runs the source
 * tree where three deep IS correct. Only production broke. So the fix is tested
 * against both layouts explicitly, and the assertion below is the one that
 * fails on the old implementation.
 */
describe("resolveRepoRoot", () => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

  test("finds the repo root from the source layout", () => {
    expect(resolveRepoRoot(resolve(repo, "src/tools/jobhunt"))).toBe(repo);
  });

  test("finds the repo root from the built layout tsc actually emits", () => {
    // The 2026-08-02 outage in one assertion: counting levels returns
    // `<repo>/dist` here, and every posting then fails to screen.
    expect(resolveRepoRoot(resolve(repo, "dist/src/tools/jobhunt"))).toBe(repo);
  });

  test("throws rather than guessing when no package.json is above", () => {
    expect(() => resolveRepoRoot("/")).toThrow(/repo root/i);
  });
});

describe("SPONSOR_REGISTER_PATH", () => {
  test("points at a register that exists on disk", () => {
    // The loader's own failure mode, asserted directly: if this path is wrong,
    // screening does not degrade — it stops entirely.
    expect(existsSync(SPONSOR_REGISTER_PATH)).toBe(true);
  });

  test("honours the IND_SPONSOR_REGISTER_PATH override", () => {
    expect(registerPathFrom({ IND_SPONSOR_REGISTER_PATH: "/tmp/reg.csv" })).toBe("/tmp/reg.csv");
  });

  test("falls back to the repo-relative register when no override is set", () => {
    expect(registerPathFrom({})).toBe(SPONSOR_REGISTER_PATH);
  });
});
