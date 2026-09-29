/**
 * SUBMIT STAYS HUMAN, the TypeScript adapter side.
 *
 * On 2026-08-24 `submit_application` clicked Submit before any approval existed.
 * The rule since (ADR-018): the machine fills and stops, and the only click that
 * sends an application is the founder's own. The Mac client's Python adapters
 * are pinned by mac-client/tests/test_submit_stays_human.py; this pins the
 * ATS adapters in src/tools/jobhunt/adapters/. They are pure HTTP readers of a
 * board's public job feed, and they must stay that: no browser library, no
 * click, and no mention of a submit button ("Submit", "Verzenden", "Versturen").
 */

import { readdirSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const ADAPTERS_DIR = new URL("../../../src/tools/jobhunt/adapters/", import.meta.url);

/** Code with block and line comments removed, keeping the `//` inside URLs. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FORBIDDEN =
  /\bplaywright\b|\bpuppeteer\b|\bchromium\b|\bselenium\b|\.click\s*\(|\.dispatchEvent\s*\(|\.requestSubmit\s*\(|\bsubmit\b|verzend|versturen|solliciteer/i;

const adapterFiles = readdirSync(ADAPTERS_DIR).filter((name) => name.endsWith(".ts"));

describe("the ATS adapters never touch an employer's submit button", () => {
  it("finds the adapter sources it is meant to scan", () => {
    // Otherwise a moved directory would make every check below pass on nothing.
    expect(adapterFiles).toEqual(expect.arrayContaining(["greenhouse.ts", "lever.ts", "smartrecruiters.ts", "workday.ts"]));
  });

  for (const file of adapterFiles) {
    const code = codeOnly(readFileSync(new URL(file, ADAPTERS_DIR), "utf8"));

    it(`${file}: no browser automation, click or submit`, () => {
      expect(code.match(FORBIDDEN)?.[0] ?? null).toBeNull();
    });

    it(`${file}: imports only its own siblings, never a package`, () => {
      const specifiers = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
      expect(specifiers.filter((s) => !s.startsWith("."))).toEqual([]);
    });
  }

  it("would notice a click and a Dutch submit button (the guard can fail)", () => {
    expect(codeOnly(`await page.getByRole("button", { name: "Verzenden" }).click();`).match(FORBIDDEN)).not.toBeNull();
    expect(codeOnly(`import { chromium } from "playwright";`).match(FORBIDDEN)).not.toBeNull();
    expect(codeOnly(`// we never submit\nconst ok = 1;`).match(FORBIDDEN)).toBeNull();
  });
});
