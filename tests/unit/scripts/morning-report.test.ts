import { describe, expect, it } from "vitest";
import { composeMorningReport, TELEGRAM_CHUNK_CHARS, type JourneyResult } from "../../../scripts/lib/morning-report.js";

const RESULTS: JourneyResult[] = [
  { id: "J1", status: "green", detail: "named \"Q4 invoice\"" },
  { id: "J2", status: "red", detail: "missing from the reply: Oplify sync" },
  { id: "J3", status: "green", detail: "2 PRs and verdicts match" },
  { id: "J4", status: "not_built", detail: "waits for AG-056 job row" },
  { id: "J5", status: "green", detail: "fired in 2.1 min" },
  { id: "A", status: "green", detail: "PR opened in 3 min" },
  { id: "B", status: "red", detail: "left: bot says 30, GitHub says 9" },
  { id: "C", status: "green", detail: "latest bot message 3.0h ago" },
];
const HEALTH = { ok: false, lines: ["🔴 AI Studio: HTTP 402 credits exhausted", "🟢 Claude CLI: answered"] };

describe("composeMorningReport", () => {
  const text = composeMorningReport(RESULTS, HEALTH, "Credits used by this run: $0.12.").join("\n");
  it("leads with the score", () => {
    expect(text.split("\n")[0]).toContain("3/5 daily journeys green, A–C 2/3 green");
  });
  it("gives one line per red journey with its reason", () => {
    expect(text).toContain("🔴 J2 calendar: missing from the reply: Oplify sync");
    expect(text).toContain("🔴 B /where: left: bot says 30, GitHub says 9");
  });
  it("names J4 as not built instead of dropping it", () => {
    expect(text).toContain("J4 issue + agent: not built (waits for AG-056 job row)");
  });
  it("carries the health lines and the credit delta", () => {
    expect(text).toContain("AI Studio: HTTP 402");
    expect(text).toContain("Credits used by this run: $0.12.");
  });
  it("splits a long report into chunks and drops no line", () => {
    const long = { ok: false, lines: Array.from({ length: 80 }, (_, i) => `🔴 line ${i} ${"x".repeat(80)}`) };
    const chunks = composeMorningReport(RESULTS, long, "");
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_CHUNK_CHARS);
    const joined = chunks.join("\n");
    for (let i = 0; i < 80; i++) expect(joined).toContain(`line ${i} `);
  });
});
