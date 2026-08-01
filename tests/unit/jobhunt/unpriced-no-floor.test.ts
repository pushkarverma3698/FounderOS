/**
 * Regression — an unpriced posting must not flag on a basis with no salary floor.
 *
 * PROD EVIDENCE (2026-08-01). Eight rows had been screened on the live box. Six
 * carried this exact evidence line:
 *
 *   "Salary: No salary stated — normal for Dutch postings. Confirm the employer
 *    can meet €52284 base before investing in an application."
 *
 * One of them (IMC) had an EXACT IND recognised-sponsor register match. It still
 * did not reach DO TODAY.
 *
 * The mechanism: `screenSalaryFacts` returned `flag` from BOTH branches when no
 * figure was stated — including the branch whose own evidence string reads "No
 * criterion applies on this basis, so this is not a bar". It said the words and
 * returned the status that bars it.
 *
 * Because Dutch postings routinely omit salary, and because `bestOutcome` picks
 * the best status across every basis, this meant the partner-permit basis could
 * never rescue a posting the HSM basis flagged. DO TODAY was structurally
 * near-empty no matter how good the supply was — the founder's actual complaint.
 *
 * The floor still binds under HSM. That is a legal condition of that permit and
 * nothing here touches it.
 */

import { describe, it, expect } from "vitest";
import { screenSalaryFacts } from "../../../src/tools/jobhunt/filters.js";
import type { SalaryFacts } from "../../../src/tools/jobhunt/extract.js";

/** What a Dutch posting with no pay information extracts to. */
const UNPRICED: SalaryFacts = { raw: null } as unknown as SalaryFacts;

/** Inside the verified 2026 criterion window, so the criterion itself is not the variable. */
const IN_WINDOW = new Date("2026-08-01T00:00:00Z");

describe("screenSalaryFacts — unpriced posting, no floor on this basis", () => {
  it("PASSES on a partner permit rather than flagging", () => {
    const result = screenSalaryFacts(UNPRICED, { route: "partner-permit", now: IN_WINDOW });
    expect(result.status).toBe("pass");
  });

  it("PASSES on a remote contract rather than flagging", () => {
    const result = screenSalaryFacts(UNPRICED, { route: "remote-contract", now: IN_WINDOW });
    expect(result.status).toBe("pass");
  });

  it("still says the pay is unstated, so it never reads as a confirmed offer", () => {
    // Passing must not mean "the money is fine" — nobody checked. The row is
    // actionable; the question just moves to first contact instead of blocking.
    const result = screenSalaryFacts(UNPRICED, { route: "partner-permit", now: IN_WINDOW });
    expect(result.evidence).toMatch(/no salary stated/i);
    expect(result.evidence).toMatch(/ask/i);
  });

  it("does NOT quote the IND floor as something to satisfy on this basis", () => {
    // Quoting €52,284 here is what made a non-binding number look like a bar.
    const result = screenSalaryFacts(UNPRICED, { route: "partner-permit", now: IN_WINDOW });
    expect(result.evidence).not.toMatch(/52284|52,284/);
  });

  it("STILL flags under HSM — the floor is a legal condition of that permit", () => {
    const result = screenSalaryFacts(UNPRICED, { route: "hsm", now: IN_WINDOW });
    expect(result.status).toBe("flag");
    expect(result.evidence).toMatch(/52284/);
  });
});
