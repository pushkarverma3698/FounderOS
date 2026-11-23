import { describe, expect, it, vi } from "vitest";
import { atsGate, buildAtsRecord, formatAtsTag, parseAts } from "../../../src/tools/jobhunt/ats-record.js";
import { tailorForRow, tailorPerRunCap, type TailorDeps } from "../../../src/tools/jobhunt/ats-tailor.js";
import type { JobSearchProfile } from "../../../src/tools/jobhunt/profile-config.js";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const profile = { id: "p1" } as JobSearchProfile;
const DESC = "We need a TypeScript engineer who knows Postgres, Kubernetes and AWS.";
const row = (over: Record<string, unknown> = {}) => ({ id: "abcdef12-0000", company: "Acme", title: "Eng", track: "ai", description: DESC, ats_json: null, ...over });
const GOOD = { success: true, tailoredMarkdown: "# Pushkar Verma\n\n## SKILLS\n\nTypeScript, Postgres", matchedSkills: ["TypeScript"], missingSkills: Array.from({ length: 14 }, (_, i) => `s${i}`), initialOverlapRatio: 0.42, track: "backend" };

function mkDeps(over: Partial<TailorDeps> = {}) {
  const tailor = vi.fn(async () => GOOD);
  const writeFile = vi.fn(async (_p: string, _d: Buffer) => undefined);
  const recordAts = vi.fn(async (_id: string, _j: string) => undefined);
  const deps: TailorDeps = { tailor, render: async () => Buffer.from("pdf"), pdfText: async () => "Pushkar Verma SKILLS TypeScript Postgres", fileExists: async () => false, writeFile, recordAts, ...over };
  return { deps, tailor, writeFile, recordAts };
}

describe("tailorForRow", () => {
  it("tailors, writes the PDF at the tailored path and stores the top-10 ATS record", async () => {
    const { deps, writeFile, recordAts } = mkDeps();
    const out = await tailorForRow(deps, row(), profile, "/art", { left: 5 });
    expect(writeFile).toHaveBeenCalledWith("/art/cv-acme-abcdef12.pdf", expect.any(Buffer));
    expect(out).toMatchObject({ tailored: true, initialOverlapRatio: 0.42, matchedSkills: ["TypeScript"] });
    expect(out?.missingSkills).toHaveLength(10);
    expect(JSON.parse(recordAts.mock.calls[0]![1]).tailored).toBe(true);
  });

  it("records the chosen track and the score after tailoring", async () => {
    const { deps } = mkDeps();
    const out = await tailorForRow(deps, row(), profile, "/art", { left: 5 });
    expect(out?.track).toBe("backend");
    expect(out?.finalOverlapRatio).toBeGreaterThanOrEqual(0);
    expect(formatAtsTag(buildAtsRecord({ ratio: 0.62, matched: ["a"], missing: [], tailored: true, finalRatio: 0.71 }))).toBe("ATS 62%→71%, tailored yes");
    expect(formatAtsTag(buildAtsRecord({ ratio: 0.62, matched: ["a"], missing: [], tailored: false }))).toBe("ATS 62%, tailored no");
    expect(parseAts(JSON.stringify(out))?.finalOverlapRatio).toBe(out?.finalOverlapRatio);
  });

  it("keeps the base CV and records 'failed pdf parse' when the PDF text lacks the name, a heading or a matched skill", async () => {
    for (const text of ["", "SKILLS TypeScript", "Pushkar Verma TypeScript", "Pushkar Verma SKILLS Python"]) {
      const { deps, writeFile } = mkDeps({ pdfText: async () => text });
      const out = await tailorForRow(deps, row(), profile, "/art", { left: 5 });
      expect(writeFile).not.toHaveBeenCalled();
      expect(out).toMatchObject({ tailored: false, tailor: "failed pdf parse" });
    }
    const { deps } = mkDeps({ pdfText: async () => { throw new Error("corrupt"); } });
    expect((await tailorForRow(deps, row(), profile, "/art", { left: 5 }))?.tailor).toBe("failed pdf parse");
  });

  it("is idempotent: a recorded row or an existing file never calls the model again", async () => {
    const a = mkDeps();
    const prior = JSON.stringify(buildAtsRecord({ ratio: 0.3, matched: ["a"], missing: ["b"], tailored: false, tailor: "failed x" }));
    const out = await tailorForRow(a.deps, row({ ats_json: prior }), profile, "/art", { left: 5 });
    expect(a.tailor).not.toHaveBeenCalled();
    expect(out?.tailor).toBe("failed x");

    const b = mkDeps({ fileExists: async () => true });
    const out2 = await tailorForRow(b.deps, row(), profile, "/art", { left: 5 });
    expect(b.tailor).not.toHaveBeenCalled();
    expect(out2?.tailored).toBe(true);
  });

  it("keeps the base CV and records the reason when tailoring fails (reject, model error)", async () => {
    const rejected = vi.fn(async () => ({ success: false, matchedSkills: ["ts"], missingSkills: ["go"], initialOverlapRatio: 0.5, error: "claim guard: Rust" }));
    const thrown = vi.fn(async () => {
      throw new Error("429 quota");
    });
    for (const tailor of [rejected, thrown]) {
      const { deps, writeFile } = mkDeps({ tailor: tailor as never });
      const out = await tailorForRow(deps, row(), profile, "/art", { left: 5 });
      expect(writeFile).not.toHaveBeenCalled();
      expect(out?.tailored).toBe(false);
      expect(out?.tailor).toMatch(/^failed (claim guard: Rust|429 quota)/);
    }
  });

  it("a render failure is a tailor failure, not a crash", async () => {
    const { deps } = mkDeps({
      render: async () => {
        throw new Error("chromium gone");
      },
    });
    const out = await tailorForRow(deps, row(), profile, "/art", { left: 5 });
    expect(out).toMatchObject({ tailored: false, tailor: "failed chromium gone", initialOverlapRatio: 0.42 });
  });

  it("stops at the per-run budget and writes nothing for the skipped row", async () => {
    const { deps, tailor, recordAts } = mkDeps();
    const budget = { left: 1 };
    await tailorForRow(deps, row({ id: "a1" }), profile, "/art", budget);
    const second = await tailorForRow(deps, row({ id: "b2" }), profile, "/art", budget);
    expect(tailor).toHaveBeenCalledTimes(1);
    expect(second).toBeNull();
    expect(recordAts).toHaveBeenCalledTimes(1);
  });

  it("does not call the model for a posting with no description", async () => {
    const { deps, tailor } = mkDeps();
    const out = await tailorForRow(deps, row({ description: "" }), profile, "/art", { left: 5 });
    expect(tailor).not.toHaveBeenCalled();
    expect(out?.tailor).toMatch(/no usable description/);
  });

  it("per-run cap defaults to 20", () => {
    expect(tailorPerRunCap({})).toBe(20);
    expect(tailorPerRunCap({ APPLY_TAILOR_PER_RUN: "3" })).toBe(3);
    expect(tailorPerRunCap({ APPLY_TAILOR_PER_RUN: "x" })).toBe(20);
  });
});

describe("atsGate and display", () => {
  const ats = buildAtsRecord({ ratio: 0.31, matched: ["a"], missing: ["go", "rust", "k8s", "gcp"], tailored: true });
  const auto = { lane: "auto" as const, reason: "ok" };
  it("holds a row below the minimum with the exact reason", () => {
    expect(atsGate(auto, ats, 40)).toEqual({ lane: "hand_off", reason: "ATS fit 31% below 40%; missing: go, rust, k8s" });
  });
  it("record only at 0 and at or above the minimum", () => {
    expect(atsGate(auto, ats, 0)).toBe(auto);
    expect(atsGate(auto, ats, 31)).toBe(auto);
  });
  it("never gates an unmeasured row", () => {
    expect(atsGate(auto, buildAtsRecord({ ratio: 0, matched: [], missing: [], tailored: false, tailor: "failed x" }), 90)).toBe(auto);
  });
  it("formats and round-trips", () => {
    expect(formatAtsTag(ats)).toBe("ATS 31%, tailored yes");
    expect(formatAtsTag(parseAts(JSON.stringify(ats)))).toBe("ATS 31%, tailored yes");
    expect(formatAtsTag(buildAtsRecord({ ratio: 0, matched: [], missing: [], tailored: false, tailor: "failed x" }))).toBe("ATS n/a, tailored no (tailor: failed x)");
    expect(parseAts("nope")).toBeNull();
  });
});
