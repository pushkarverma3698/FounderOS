/**
 * P2-2 — a market term the CV already covers by implication is not a gap, and a
 * real gap ends in a tap. Coverage is DIRECTIONAL: a TypeScript CV covers
 * JavaScript, a JavaScript-only CV does not cover TypeScript.
 */
import { describe, it, expect } from "vitest";
import { buildGapReport, formatGapReport, type SignalRow } from "../../../src/tools/jobhunt/gaps.js";
import {
  gapAddReply,
  gapKeyboard,
  parseGapCallback,
} from "../../../src/gateway/jobhunt-gap-buttons.js";

const sig = (term: string, seen = 50, category = "language"): SignalRow => ({ term, category, seen_count: seen });
const CV_TS = "Senior engineer. TypeScript, Python, Docker, PostgreSQL, Node.js, LangGraph, RAG, unit testing.";
const CV_JS = "Senior engineer. JavaScript, Python, Docker, PostgreSQL, Node.js, LangGraph, RAG, unit testing.";

describe("buildGapReport — covered by implication", () => {
  it("a TypeScript CV does not miss JavaScript, and says why", () => {
    const r = buildGapReport([sig("JavaScript")], CV_TS, 100);
    expect(r.missing.map((m) => m.term)).not.toContain("JavaScript");
    expect(r.covered).toEqual([{ term: "JavaScript", by: "TypeScript", seen_count: 50 }]);
  });

  it("a JavaScript-only CV still misses TypeScript (not symmetric)", () => {
    const r = buildGapReport([sig("TypeScript")], CV_JS, 100);
    expect(r.missing.map((m) => m.term)).toContain("TypeScript");
    expect(r.covered).toEqual([]);
  });

  it("a CV naming PostgreSQL covers SQL", () => {
    const r = buildGapReport([sig("SQL")], CV_TS, 100);
    expect(r.missing.map((m) => m.term)).not.toContain("SQL");
  });

  it("a term with no implication rule is still missing", () => {
    expect(buildGapReport([sig("Kubernetes", 40, "infra")], CV_TS, 100).missing.map((m) => m.term)).toContain("Kubernetes");
  });

  it("the report prints the covered line so the founder sees nothing was hidden", () => {
    const text = formatGapReport(buildGapReport([sig("JavaScript")], CV_TS, 100), { track: "ai" });
    expect(text).toMatch(/COVERED/);
    expect(text).toMatch(/JavaScript.*TypeScript/);
  });
});

describe("gap buttons", () => {
  const rows = [sig("Kubernetes", 40, "infra"), sig("Terraform", 30, "infra"), sig("Go", 20), sig("Rust", 10)];

  it("offers one button per missing term, at most three", () => {
    const kb = gapKeyboard("pushkar-nl-tech", rows)!.inline_keyboard;
    expect(kb).toHaveLength(3);
    expect(kb[0]![0]!.text).toContain("Kubernetes");
  });

  it("returns no keyboard when nothing is missing", () => {
    expect(gapKeyboard("pushkar-nl-tech", [])).toBeNull();
  });

  it("round-trips and keeps callback_data inside 64 bytes; a term that cannot fit gets no button", () => {
    const kb = gapKeyboard("pushkar-nl-tech", [...rows, sig("X".repeat(80))])!.inline_keyboard;
    for (const row of kb)
      for (const b of row) {
        const data = (b as { callback_data: string }).callback_data;
        expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
        expect(parseGapCallback(data)).toMatchObject({ profileId: "pushkar-nl-tech" });
      }
    expect(parseGapCallback("jh:g:p:Kubernetes")).toEqual({ profileId: "p", term: "Kubernetes" });
    expect(parseGapCallback("jh:d:abc")).toBeNull();
  });

  it("the tap reply says only add it if true and that the bot will not edit the CV", () => {
    const reply = gapAddReply("Kubernetes");
    expect(reply).toContain("Kubernetes");
    expect(reply).toMatch(/only if/i);
    expect(reply).toMatch(/won't edit|will not edit/i);
  });
});

describe("handleGaps — buttons under the report", () => {
  it("replies with the report and the add-to-CV keyboard", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.doMock("../../../src/tools/jobhunt/gaps.js", async (orig) => ({
      ...(await orig<typeof import("../../../src/tools/jobhunt/gaps.js")>()),
      computeGaps: async () => ({
        ok: true,
        track: "ai",
        cvPath: "/cv.md",
        report: { sampleSize: 40, missing: [sig("Kubernetes", 20, "infra")], confirmed: [], rising: [], cvTermCount: 9, covered: [] },
      }),
    }));
    const { handleGaps } = await import("../../../src/gateway/jobhunt-gaps-view.js");
    const reply = vi.fn(async () => undefined);
    await handleGaps({ match: "", reply } as never);
    const [text, opts] = reply.mock.calls[0] as unknown as [string, { reply_markup: { inline_keyboard: unknown[][] } }];
    expect(text).toContain("Kubernetes");
    expect(opts.reply_markup.inline_keyboard).toHaveLength(1);
    vi.doUnmock("../../../src/tools/jobhunt/gaps.js");
  });
});
