/**
 * Unit tests — the gate record, and the bug it exists to close.
 *
 * THE BUG (production, 2026-08-01). `combineVerdict` mapped `Gate[]` to
 * `reasons: string[]` and dropped `g.status` on that line. Everything downstream
 * saw a flat pipe-joined string, so the brief picked reason #1 as the row's
 * headline and `/ask` handed the model all three gates under the heading "What
 * is unresolved". A row flagged on SALARY was therefore labelled with its
 * PASSING sponsor line. The founder's verdict on that brief was that he could
 * not tell why any company was on the list.
 *
 * The property being tested is not "the string looks nicer". It is that the
 * reason shown is derived from STATUS and never from POSITION.
 */

import { describe, it, expect } from "vitest";
import {
  blockingGates,
  combineVerdict,
  parseGates,
  serialiseGates,
  type Gate,
} from "../../../src/tools/jobhunt/gates.js";
import { whyLine, gateLines, type BriefRow } from "../../../src/tools/jobhunt/brief-row.js";

const SPONSOR_PASS: Gate = {
  gate: "Sponsor",
  status: "pass",
  evidence: 'Exact register match: "BridgeFund B.V.".',
};
const SALARY_FLAG: Gate = {
  gate: "Salary",
  status: "flag",
  evidence: "No salary stated — ask at first contact.",
};
const LANGUAGE_PASS: Gate = {
  gate: "Language",
  status: "pass",
  evidence: "No Dutch-language requirement found.",
};

function briefRow(over: Partial<BriefRow> = {}): BriefRow {
  return {
    id: "r1",
    company: "BridgeFund",
    title: "Backend Engineer",
    track: "backend",
    verdict: "flag",
    route: "hsm",
    url: null,
    overlap: { matched: [], missing: [], asked: 0, ratio: 0 },
    liveness: "unverifiable",
    gates: [SPONSOR_PASS, SALARY_FLAG, LANGUAGE_PASS],
    legacyGates: false,
    ageDays: 0,
    ...over,
  };
}

describe("combineVerdict", () => {
  it("carries every gate's own status through, not just the combined one", () => {
    const verdict = combineVerdict([SPONSOR_PASS, SALARY_FLAG, LANGUAGE_PASS]);
    expect(verdict.status).toBe("flag");
    expect(verdict.gates.map((g) => g.status)).toEqual(["pass", "flag", "pass"]);
  });

  it("still lets a reject absorb everything else", () => {
    const verdict = combineVerdict([
      SPONSOR_PASS,
      { gate: "Experience", status: "reject", evidence: "Asks for 8 years minimum." },
      SALARY_FLAG,
    ]);
    expect(verdict.status).toBe("reject");
  });
});

describe("blockingGates", () => {
  it("returns the FAILING gate, not the first one", () => {
    // The whole bug in one assertion. Sponsor is first and it passed.
    const verdict = combineVerdict([SPONSOR_PASS, SALARY_FLAG, LANGUAGE_PASS]);
    expect(blockingGates(verdict).map((g) => g.gate)).toEqual(["Salary"]);
  });

  it("returns nothing for a clean pass rather than falling back to gate #1", () => {
    const verdict = combineVerdict([SPONSOR_PASS, LANGUAGE_PASS]);
    expect(blockingGates(verdict)).toEqual([]);
  });

  it("ignores flags once something rejects — a reject is not one question away", () => {
    const reject: Gate = { gate: "Language", status: "reject", evidence: "Dutch required." };
    const verdict = combineVerdict([SPONSOR_PASS, SALARY_FLAG, reject]);
    expect(blockingGates(verdict).map((g) => g.gate)).toEqual(["Language"]);
  });
});

describe("serialiseGates / parseGates", () => {
  it("round-trips a gate record", () => {
    const gates = [SPONSOR_PASS, SALARY_FLAG, LANGUAGE_PASS];
    const { gates: back, legacy } = parseGates({ gate_json: serialiseGates(gates) });
    expect(legacy).toBe(false);
    expect(back).toEqual(gates);
  });

  it("reads a pre-gate_json row back as UNKNOWN, never as passing", () => {
    // Every row in production on 2026-08-01 predates the column. Guessing "pass"
    // would put a row into APPLY TODAY on no evidence; guessing "reject" would
    // bury a real opportunity. "We don't know, go and look" is the only claim
    // the stored data supports.
    const { gates, legacy } = parseGates({
      salary_evidence: "Sponsor: exact match. | Salary: no figure stated.",
    });
    expect(legacy).toBe(true);
    expect(gates.map((g) => g.gate)).toEqual(["Sponsor", "Salary"]);
    expect(gates.every((g) => g.status === "flag")).toBe(true);
  });

  it("survives malformed JSON rather than throwing away the brief", () => {
    const { gates, legacy } = parseGates({
      gate_json: "{not json",
      salary_evidence: "Sponsor: exact match.",
    });
    expect(legacy).toBe(true);
    expect(gates).toHaveLength(1);
  });

  it("drops entries that are not gates instead of trusting the shape", () => {
    const { gates } = parseGates({
      gate_json: JSON.stringify([SPONSOR_PASS, { gate: "X" }, { status: "banana" }]),
    });
    expect(gates).toEqual([SPONSOR_PASS]);
  });
});

describe("whyLine — the founder-facing sentence", () => {
  it("names the FAILING check, never the first one", () => {
    const out = whyLine(briefRow());
    expect(out).toContain("Salary");
    expect(out).not.toContain("Sponsor");
  });

  it("names every failing check when more than one is open", () => {
    const out = whyLine(
      briefRow({
        gates: [
          { gate: "Sponsor", status: "flag", evidence: "partial overlap" },
          { gate: "Salary", status: "pass", evidence: "clears the floor" },
          { gate: "Language", status: "flag", evidence: "Dutch mentioned" },
        ],
      }),
    );
    expect(out).toContain("Sponsor and Language");
  });

  it("says a pass is a pass rather than quoting a check at it", () => {
    const out = whyLine(briefRow({ verdict: "pass", gates: [SPONSOR_PASS, LANGUAGE_PASS] }));
    expect(out).toContain("every check below cleared");
  });

  it("admits when the row predates the gate record", () => {
    const out = whyLine(briefRow({ legacyGates: true }));
    expect(out).toContain("cannot say which check passed");
  });
});

describe("gateLines", () => {
  it("prints one bullet per check, each with its own mark", () => {
    const lines = gateLines([SPONSOR_PASS, SALARY_FLAG, LANGUAGE_PASS]).split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("✅");
    expect(lines[1]).toContain("❓");
    expect(lines[2]).toContain("✅");
  });

  it("refuses to imply a verdict it has no checks for", () => {
    expect(gateLines([])).toContain("do not trust the verdict");
  });
});
