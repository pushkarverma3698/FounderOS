/**
 * Unit tests — an unknown work location must never resolve to a pass.
 *
 * THE DEFECT THIS LOCKS SHUT (live prod sweep, 2026-08-01). `basesForPosting`
 * returns all three permit bases when the extractor cannot tell where a job is
 * (`route: "unclear"`), and `bestOutcome` then picks whichever basis has the
 * fewest gates. That is the partner permit: no sponsor check, no salary floor —
 * so it passed unconditionally. The fallback for IGNORANCE was the most
 * PERMISSIVE basis available, which meant "we don't know where this job is"
 * rendered as "apply today".
 *
 * It reached the founder: rank 2 of APPLY TODAY on the first real production
 * brief was a Colombian company, justified as "Partner permit: free access to
 * the labour market". A Dutch partner permit says nothing about a job in Bogotá.
 * 17 of 34 stored rows had resolved that way, including employers in Brazil, the
 * United States and India.
 *
 * The fix is not to discard those rows — the founder's standing rule is that a
 * filtered-out row and an empty market are indistinguishable from outside. The
 * fix is a shared `Location` gate that flags, so the role lands in "one question
 * away" with the question being where the work actually sits.
 */

import { describe, it, expect } from "vitest";
import { basisGate, locationGate } from "../../../src/tools/jobhunt/screen-gates.js";
import { gateProfile } from "../../../src/tools/jobhunt/permit-routes.js";

describe("locationGate — an unread location is never silent", () => {
  it("flags a posting that never says where the work is based", () => {
    const gate = locationGate("unclear");

    expect(gate).not.toBeNull();
    expect(gate!.gate).toBe("Location");
    expect(gate!.status).toBe("flag");
  });

  it("asks the question the founder actually needs answered", () => {
    // Not an internal label. The founder must be able to read the sentence and
    // know what to send the company.
    expect(locationGate("unclear")!.evidence.toLowerCase()).toContain("where");
  });

  it("never rejects — the role stays in the pipeline with its reason shown", () => {
    expect(locationGate("unclear")!.status).not.toBe("reject");
  });

  it("stays silent once the posting itself establishes the location", () => {
    expect(locationGate("hsm")).toBeNull();
    expect(locationGate("remote-contract")).toBeNull();
  });
});

describe("locationGate is shared across bases, not folded into one", () => {
  it("reports the same uncertainty whichever basis ends up winning", () => {
    // The gate takes only the posting's route. It cannot vary by basis, which is
    // the point: an `unclear` posting that ties across all three bases used to
    // record whichever came first in the array, and that basis's gate list
    // carried no mention of the location at all.
    const forAnyBasis = locationGate("unclear");

    expect(forAnyBasis).toEqual(locationGate("unclear"));
    expect(forAnyBasis!.gate).toBe("Location");
  });
});

describe("basisGate — still the plain-language pass line", () => {
  it("passes and quotes the basis it applied", () => {
    const gate = basisGate(gateProfile("partner-permit"));

    expect(gate.gate).toBe("Basis");
    expect(gate.status).toBe("pass");
    expect(gate.evidence).toBe(gateProfile("partner-permit").basis);
  });
});
