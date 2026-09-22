/**
 * Unit tests for the evidence pack renderer.
 *
 * The behaviour that matters most here is the skipped-stage rule: a vision stage
 * that did not run must be printed as SKIPPED with its reason, never as a clean
 * pass. src/evolution/run-audit.ts carries the same rule because prod once
 * rendered a tier that never ran as a tier that came back clean.
 */

import { describe, it, expect } from "vitest";
import { renderEvidencePack, type VisionStage } from "../../../../src/tools/browser/evidence-pack.js";
import type { UiCheckRow } from "../../../../src/tools/browser/ui-analyze.js";

const cleanRow: UiCheckRow = {
  target: "neon",
  url: "/assets/cinematic-presets/neon/index.html",
  viewport: "desktop",
  ok: true,
  defects: [],
  screenshotPath: "/out/screenshots/neon-desktop.png",
};

const brokenRow: UiCheckRow = {
  target: "terminal",
  url: "/assets/cinematic-presets/terminal/index.html",
  viewport: "mobile",
  ok: false,
  defects: [
    { kind: "unsubstituted-placeholder", severity: "high", detail: "The page still shows 1 template placeholder that was never filled in: {{TAGLINE}}." },
    { kind: "horizontal-overflow", severity: "medium", detail: "Content is 40px wider than the mobile viewport." },
  ],
};

const SKIPPED: VisionStage = { ran: false, skippedReason: "GOOGLE_GENERATIVE_AI_API_KEY is not set" };

describe("renderEvidencePack — the gate verdict", () => {
  it("passes when no high-severity defect was measured", () => {
    const pack = renderEvidencePack([cleanRow], SKIPPED);
    expect(pack.pass).toBe(true);
    expect(pack.highSeverityCount).toBe(0);
    expect(pack.markdown).toContain("✅ **PASS**");
  });

  it("fails and counts the blocking defects", () => {
    const pack = renderEvidencePack([cleanRow, brokenRow], SKIPPED);
    expect(pack.pass).toBe(false);
    expect(pack.highSeverityCount).toBe(1);
    expect(pack.markdown).toContain("❌ **FAIL**");
  });

  it("does not let a medium-severity defect block a merge", () => {
    const mediumOnly: UiCheckRow = { ...brokenRow, ok: true, defects: [brokenRow.defects[1]!] };
    expect(renderEvidencePack([mediumOnly], SKIPPED).pass).toBe(true);
  });
});

describe("renderEvidencePack — the skipped-stage rule", () => {
  it("prints SKIPPED with the reason and warns that visuals were not checked", () => {
    const md = renderEvidencePack([cleanRow], SKIPPED).markdown;
    expect(md).toContain("SKIPPED");
    expect(md).toContain("GOOGLE_GENERATIVE_AI_API_KEY is not set");
    expect(md).toContain("**NOT** checked");
  });

  it("does not fail the build merely because vision was skipped", () => {
    // Failing every PR on a missing key would train everyone to ignore the gate.
    expect(renderEvidencePack([cleanRow], SKIPPED).pass).toBe(true);
  });

  it("marks a skipped stage as ran:false in the JSON with its reason", () => {
    const json = JSON.parse(renderEvidencePack([cleanRow], SKIPPED).json);
    expect(json.vision).toMatchObject({ ran: false, skipped_reason: "GOOGLE_GENERATIVE_AI_API_KEY is not set" });
  });
});

describe("renderEvidencePack — vision verdicts", () => {
  it("counts a high-severity visual defect toward the gate", () => {
    const stage: VisionStage = {
      ran: true,
      verdicts: [{
        target: "neon", viewport: "desktop", readable: true, ok: false,
        summary: "The headline sits on top of the hero image.",
        defects: [{ severity: "high", area: "hero", description: "Headline text overlaps the background image and is unreadable." }],
      }],
    };
    const pack = renderEvidencePack([cleanRow], stage);
    expect(pack.pass).toBe(false);
    expect(pack.highSeverityCount).toBe(1);
    expect(pack.markdown).toContain("Headline text overlaps");
  });

  it("treats an unreadable screenshot as blocking, not as a pass", () => {
    const stage: VisionStage = {
      ran: true,
      verdicts: [{ target: "neon", viewport: "desktop", readable: false, ok: false, summary: "The screenshot is entirely blank.", defects: [] }],
    };
    const pack = renderEvidencePack([cleanRow], stage);
    expect(pack.pass).toBe(false);
    expect(pack.markdown).toContain("unreadable-screenshot");
  });

  it("does NOT claim visual blockers are spread across measured rows", () => {
    // Measured on CI run 35786606697: the headline read "5 blocking defect(s)
    // across 0 of 8 page/viewport combination(s)" — five defects over zero rows
    // — printed above eight rows each saying "No measurable defects". Every
    // blocker was visual and the sentence had no word for that. A summary whose
    // arithmetic disagrees with its own rows is the exact "fabricated evidence"
    // shape the review protocol tells a gate to hunt for.
    const stage: VisionStage = {
      ran: true,
      verdicts: [{
        target: "neon", viewport: "desktop", readable: true, ok: false,
        summary: "Scaffold filler text is still on the page.",
        defects: [{ severity: "high", area: "hero", description: "Placeholder copy left in the hero." }],
      }],
    };
    const md = renderEvidencePack([cleanRow], stage).markdown;
    expect(md).toContain("1 visual");
    expect(md).toContain("rendered clean");
    expect(md).not.toContain("across 0 of");
  });

  it("labels a visual row so it cannot be read as a measured one", () => {
    // The two headings were byte-identical, so a reader scrolling a red pack
    // could not tell which stage had failed.
    const stage: VisionStage = {
      ran: true,
      verdicts: [{ target: "neon", viewport: "desktop", readable: true, ok: false, summary: "x", defects: [] }],
    };
    expect(renderEvidencePack([cleanRow], stage).markdown).toContain("FAIL — Visual: `neon`");
  });

  it("reports a per-image vision error without silently dropping it", () => {
    const stage: VisionStage = {
      ran: true,
      verdicts: [{ target: "neon", viewport: "desktop", readable: true, ok: true, summary: "Looks finished.", defects: [] }],
      errors: [{ target: "glass", viewport: "mobile", error: "Gemini HTTP 503" }],
    };
    const md = renderEvidencePack([cleanRow], stage).markdown;
    expect(md).toContain("glass");
    expect(md).toContain("Gemini HTTP 503");
  });
});

describe("renderEvidencePack — legibility and determinism", () => {
  it("prints every defect as its own bullet with its own reason", () => {
    const md = renderEvidencePack([brokenRow], SKIPPED).markdown;
    expect(md).toContain("- 🔴 **unsubstituted-placeholder**");
    expect(md).toContain("- 🟡 **horizontal-overflow**");
  });

  it("orders defects by severity so the blocking one is read first", () => {
    const md = renderEvidencePack([brokenRow], SKIPPED).markdown;
    expect(md.indexOf("unsubstituted-placeholder")).toBeLessThan(md.indexOf("horizontal-overflow"));
  });

  it("says explicitly what a clean row means rather than leaving it blank", () => {
    const md = renderEvidencePack([cleanRow], SKIPPED).markdown;
    expect(md).toContain("No measurable defects");
  });

  it("is a pure function — identical inputs render identical bytes", () => {
    const a = renderEvidencePack([cleanRow, brokenRow], SKIPPED);
    const b = renderEvidencePack([cleanRow, brokenRow], SKIPPED);
    expect(a.markdown).toBe(b.markdown);
    expect(a.json).toBe(b.json);
  });

  it("emits valid, machine-readable JSON alongside the markdown", () => {
    const json = JSON.parse(renderEvidencePack([cleanRow, brokenRow], SKIPPED).json);
    expect(json).toMatchObject({ pass: false, high_severity_count: 1, measured_high: 1, visual_high: 0 });
    expect(json.rows).toHaveLength(2);
  });
});
