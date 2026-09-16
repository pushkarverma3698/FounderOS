/**
 * Unit tests for the ui_check UnifiedTool surface and the qa:ui CLI contract.
 *
 * The browser collector is mocked — these assert the tool contract from
 * docs/rules/TOOL-STANDARDS.md (execute() never throws, bad input is a typed
 * failure, a render crash becomes a row rather than an exception), not Chromium.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { collectPageFactsMock, capturePngMock } = vi.hoisted(() => ({
  collectPageFactsMock: vi.fn(),
  capturePngMock: vi.fn(),
}));

vi.mock("../../../../src/tools/browser/ui-facts.js", () => ({
  collectPageFacts: collectPageFactsMock,
  capturePng: capturePngMock,
}));

import { uiCheckTool, runUiCheck, highSeverityCount } from "../../../../src/tools/browser/ui-check.js";
import { parseArgs, defaultTargets, PRESET_IDS, runVision } from "../../../../scripts/qa-ui.js";

function factsFor(target: string, viewport: "desktop" | "mobile", over: Record<string, unknown> = {}) {
  return {
    target,
    url: `/x/${target}.html`,
    viewport,
    title: "Acme Robotics — Launch",
    bodyText: "Acme Robotics builds robots for teams everywhere, with a promise worth reading twice.",
    consoleErrors: [],
    pageErrors: [],
    failedAssets: [],
    scrollWidth: 1440,
    clientWidth: 1440,
    emptyBlocks: [],
    brokenImages: [],
    headingCount: 2,
    h1Count: 1,
    ...over,
  };
}

describe("runUiCheck", () => {
  beforeEach(() => {
    collectPageFactsMock.mockReset();
    capturePngMock.mockReset();
  });

  it("checks every target at every viewport", async () => {
    collectPageFactsMock.mockImplementation((t: { id: string }, v: "desktop" | "mobile") =>
      Promise.resolve(factsFor(t.id, v)),
    );
    const rows = await runUiCheck({
      targets: [{ id: "neon", url: "/x/neon.html" }, { id: "glass", url: "/x/glass.html" }],
      viewports: ["desktop", "mobile"],
    });
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.ok)).toBe(true);
  });

  it("turns a render crash into a HIGH render-failed row instead of throwing", async () => {
    // A crash that produced no row would be indistinguishable from a clean pass.
    collectPageFactsMock.mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"));
    const rows = await runUiCheck({ targets: [{ id: "neon", url: "http://localhost:1/x" }], viewports: ["desktop"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ok).toBe(false);
    expect(rows[0]?.defects[0]?.kind).toBe("render-failed");
    expect(rows[0]?.defects[0]?.detail).toContain("ERR_CONNECTION_REFUSED");
  });

  it("attaches a screenshot path only when a screenshot directory is given", async () => {
    collectPageFactsMock.mockResolvedValue(factsFor("neon", "desktop"));
    capturePngMock.mockResolvedValue("/out/neon-desktop.png");

    const without = await runUiCheck({ targets: [{ id: "neon", url: "/x" }], viewports: ["desktop"] });
    expect(without[0]?.screenshotPath).toBeUndefined();
    expect(capturePngMock).not.toHaveBeenCalled();

    const withDir = await runUiCheck({ targets: [{ id: "neon", url: "/x" }], viewports: ["desktop"], screenshotDir: "/out" });
    expect(withDir[0]?.screenshotPath).toBe("/out/neon-desktop.png");
  });

  it("passes substitutions through to the collector", async () => {
    collectPageFactsMock.mockResolvedValue(factsFor("neon", "desktop"));
    await runUiCheck({ targets: [{ id: "neon", url: "/x" }], viewports: ["desktop"], substitutions: { CLIENT: "Acme" } });
    expect(collectPageFactsMock).toHaveBeenCalledWith({ id: "neon", url: "/x" }, "desktop", { CLIENT: "Acme" });
  });

  it("counts high-severity defects across all rows", async () => {
    collectPageFactsMock.mockResolvedValue(factsFor("neon", "desktop", { bodyText: "{{TAGLINE}}" }));
    const rows = await runUiCheck({ targets: [{ id: "neon", url: "/x" }], viewports: ["desktop"] });
    // A body of "{{TAGLINE}}" trips both the placeholder and blank-page checks.
    expect(highSeverityCount(rows)).toBe(2);
  });
});

describe("uiCheckTool — UnifiedTool contract", () => {
  beforeEach(() => collectPageFactsMock.mockReset());

  it("returns a typed failure, never throws, when urls is missing or empty", async () => {
    await expect(uiCheckTool.execute({})).resolves.toMatchObject({ success: false });
    const res = await uiCheckTool.execute({ urls: [] });
    expect(res.success).toBe(false);
    expect(res.error).toContain("at least one URL");
  });

  it("ignores non-string entries rather than rendering undefined", async () => {
    const res = await uiCheckTool.execute({ urls: [42, null] });
    expect(res.success).toBe(false);
  });

  it("reports success with an observed evidence line", async () => {
    collectPageFactsMock.mockResolvedValue(factsFor("target-1", "desktop"));
    const res = await uiCheckTool.execute({ urls: ["/x/neon.html"], viewports: ["desktop"] });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ checked: 1, high_severity: 0, ok: true });
    expect(res.observed?.evidence).toContain("1 page/viewport");
  });

  it("reports ok:false when a blocking defect is found", async () => {
    collectPageFactsMock.mockResolvedValue(factsFor("target-1", "desktop", { bodyText: "Welcome to {{TAGLINE}}, the robotics company built for teams." }));
    const res = await uiCheckTool.execute({ urls: ["/x/neon.html"], viewports: ["desktop"] });
    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({ ok: false });
  });

  it("defaults to both viewports when none are given", async () => {
    collectPageFactsMock.mockImplementation((_t: unknown, v: "desktop" | "mobile") => Promise.resolve(factsFor("target-1", v)));
    const res = await uiCheckTool.execute({ urls: ["/x/neon.html"] });
    expect(res.data).toMatchObject({ checked: 2 });
  });
});

describe("qa:ui CLI contract", () => {
  it("defaults to the four cinematic preset scaffolds", () => {
    const targets = defaultTargets();
    expect(targets.map((t) => t.id).sort()).toEqual([...PRESET_IDS].sort());
    for (const t of targets) expect(t.url).toContain("assets/cinematic-presets");
  });

  it("is deterministic and free by default — no vision unless asked", () => {
    expect(parseArgs([]).vision).toBe(false);
    expect(parseArgs(["--vision"]).vision).toBe(true);
  });

  it("parses out, client and viewport flags", () => {
    const args = parseArgs(["--out", ".artifacts/ui-qa", "--client", "Acme Robotics", "--viewport", "desktop"]);
    expect(args.out).toBe(".artifacts/ui-qa");
    expect(args.client).toBe("Acme Robotics");
    expect(args.viewports).toEqual(["desktop"]);
  });

  it("checks both viewports when none is named", () => {
    expect(parseArgs([]).viewports).toEqual(["desktop", "mobile"]);
  });

  it("substitutes a default client name so a scaffold is checked as a visitor receives it", () => {
    // Rendering raw {{CLIENT}} would make every preset fail on every run, which
    // is the gate crying wolf rather than catching anything.
    expect(parseArgs([]).client.length).toBeGreaterThan(0);
  });

  it("accepts an explicit id=path target and overrides the defaults", () => {
    const args = parseArgs(["--target", "showcase=/tmp/site/index.html"]);
    expect(args.targets).toHaveLength(1);
    expect(args.targets[0]?.id).toBe("showcase");
    expect(args.targets[0]?.url).toContain("/tmp/site/index.html");
  });

  it("ignores an unknown viewport rather than checking a bogus size", () => {
    expect(parseArgs(["--viewport", "watch"]).viewports).toEqual(["desktop", "mobile"]);
  });
});

describe("runVision — the vision stage never takes the deterministic run down with it", () => {
  const envBackup = { ...process.env };

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("returns a SKIPPED stage instead of throwing when a screenshot cannot be read", async () => {
    // Historically, an exception anywhere in this stage's body — the CI
    // incident was ui-vision.js's import chain hitting core/config's required
    // DATABASE_URL/TELEGRAM_* — escaped runVision and crashed the whole qa:ui
    // run, discarding the already-computed deterministic results. A real
    // ENOENT here exercises the same escape hatch without mocking: any throw
    // inside the stage's try block must land as a SKIPPED VisionStage, never
    // an uncaught rejection.
    process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = "dummy-key-for-import-test";
    const stage = await runVision([
      { target: "neon", viewport: "desktop", path: "/tmp/does-not-exist-ui-qa-test.png" },
    ]);

    expect(stage.ran).toBe(false);
    expect(stage.skippedReason).toContain("ENOENT");
  });

  it("still returns the no-key skip without touching the import at all", async () => {
    delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
    const stage = await runVision([{ target: "neon", viewport: "desktop", path: "/tmp/x.png" }]);
    expect(stage).toEqual({ ran: false, skippedReason: "GOOGLE_GENERATIVE_AI_API_KEY is not set" });
  });
});
