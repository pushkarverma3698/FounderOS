/**
 * The committed apply-profile templates must parse once their placeholders are
 * filled — a template the validator rejects is copied, filled in, and then
 * refused by `/profile` on the first line nobody thought to check.
 *
 * Found 2026-09-28: Tashi's template carried `work_authorization:
 * "orientation-year-permit"`, outside the closed set, and a detail line saying
 * she currently HOLDS a zoekjaar permit — the fact the founder corrected on
 * 2026-09-08 (she will apply for it once an offer lands; see
 * profiles/wife-nl-finance.ts).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Fill the REPLACE placeholders with values of the right shape. */
function filled(template: string): string {
  const json = JSON.parse(template) as Record<string, unknown>;
  for (const [key, value] of Object.entries(json)) {
    if (value !== "REPLACE") continue;
    json[key] = key === "email" ? "someone@example.com" : key === "linkedin" ? "https://linkedin.com/in/x" : "X";
  }
  return JSON.stringify(json);
}

describe("apply-profile templates", () => {
  it.each(["apply-profile.example.json", "apply-profile-wife.example.json"])("%s parses once filled in", (file) => {
    const result = parseApplyProfile(filled(read(`../../../mac-client/${file}`)));
    expect(result.ok ? "ok" : result.reason).toBe("ok");
  });

  it("does not tell an employer Tashi holds a permit she has not applied for yet", () => {
    const text = read("../../../mac-client/apply-profile-wife.example.json");
    expect(text).not.toMatch(/currently holding/i);
  });
});
