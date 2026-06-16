// tests/unit/log-review/digest.test.ts
import { describe, it, expect } from "vitest";
import { buildDigest, MAX_DIGEST_TURNS } from "../../../scripts/log-review/digest.js";
import type { Turn, Anomaly } from "../../../scripts/log-review/types.js";

const turn = (id: string): Turn => ({
  turnId: id, startMs: 0, endMs: 1, lines: [], toolErrors: 0, hadError: false,
});
const cand = (id: string): Anomaly => ({
  type: "hallucination_candidate", severity: "low", turnId: id,
  summary: "c", evidence: ["e"],
});

describe("buildDigest", () => {
  it("collapses healthy turns into counts and caps borderline turns", () => {
    const turns = Array.from({ length: MAX_DIGEST_TURNS + 5 }, (_, i) => turn(`T${i}`));
    const anomalies = turns.map((t) => cand(t.turnId));
    const d = buildDigest(turns, anomalies, [], { windowDays: 7 });
    expect(d.borderlineTurns.length).toBe(MAX_DIGEST_TURNS);
    expect(d.truncated).toBe(true);
    expect(d.counts.turns).toBe(MAX_DIGEST_TURNS + 5);
  });

  it("produces a stable content hash for the same issue set", () => {
    const turns = [turn("A")];
    const anomalies: Anomaly[] = [
      { type: "error", severity: "high", turnId: "A", summary: "x", evidence: ["e"] },
    ];
    const a = buildDigest(turns, anomalies, [], { windowDays: 7 });
    const b = buildDigest(turns, anomalies, [], { windowDays: 7 });
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).toMatch(/^[a-f0-9]{12}$/);
  });

  it("hash changes when the issue set changes", () => {
    const turns = [turn("A")];
    const a = buildDigest(turns, [{ type: "error", severity: "high", turnId: "A", summary: "x", evidence: [] }], [], { windowDays: 7 });
    const b = buildDigest(turns, [{ type: "wedge", severity: "high", turnId: "A", summary: "y", evidence: [] }], [], { windowDays: 7 });
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});
