import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyProfile } from "../../../src/tools/jobhunt/apply-profile.js";
import type { JobSearchProfile } from "../../../src/tools/jobhunt/profile-config.js";

const mockRender = vi.fn();
const mockReadCv = vi.fn();
vi.mock("../../../src/tools/jobhunt/cv-renderer.js", () => ({ renderCvToPdf: (...a: unknown[]) => mockRender(...a) }));
vi.mock("../../../src/tools/career.js", () => ({ readFullCvText: (...a: unknown[]) => mockReadCv(...a) }));

const { resolveResumePdf } = await import("../../../src/tools/jobhunt/resume-pdf.js");
const { tailoredCvPath } = await import("../../../src/tools/jobhunt/apply-packet.js");

const row = { id: "abcdef12-0000", company: "Acme", track: "" };
const profile = { id: "p1", tracks: {} } as unknown as JobSearchProfile;
const mkApply = (resume?: string) => ({ default_resume: resume }) as unknown as ApplyProfile;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "resume-pdf-"));
  mockRender.mockReset().mockResolvedValue({ pdfBuffer: Buffer.from("%PDF-rendered") });
  mockReadCv.mockReset().mockReturnValue({ ok: true, text: "# CV" });
});

describe("resolveResumePdf", () => {
  it("prefers the tailored CV over the configured path", async () => {
    const tailored = tailoredCvPath(dir, row);
    writeFileSync(tailored, "tailored");
    const configured = path.join(dir, "configured.pdf");
    writeFileSync(configured, "configured");
    expect(await resolveResumePdf(row, profile, mkApply(configured), dir)).toEqual({ ok: true, pdfPath: tailored });
    expect(mockRender).not.toHaveBeenCalled();
  });

  it("uses the configured path when it exists", async () => {
    const configured = path.join(dir, "configured.pdf");
    writeFileSync(configured, "configured");
    expect(await resolveResumePdf(row, profile, mkApply(configured), dir)).toEqual({ ok: true, pdfPath: configured });
  });

  it("renders from the base CV when the configured path is missing", async () => {
    const out = await resolveResumePdf(row, profile, mkApply("/Users/nobody/missing.pdf"), dir);
    expect(out).toEqual({ ok: true, pdfPath: path.join(dir, "cv-base-p1.pdf") });
    expect(readFileSync(path.join(dir, "cv-base-p1.pdf"), "utf8")).toBe("%PDF-rendered");
    expect(mockRender).toHaveBeenCalledWith("# CV");
  });

  it("returns ok:false with the reason when the base CV cannot be read", async () => {
    mockReadCv.mockReturnValue({ ok: false, error: "cv.md not found" });
    const out = await resolveResumePdf(row, profile, mkApply("/Users/nobody/missing.pdf"), dir);
    expect(out).toEqual({ ok: false, reason: expect.stringContaining("cv.md not found") });
  });

  it("returns ok:false when rendering fails", async () => {
    mockRender.mockRejectedValue(new Error("chromium down"));
    const out = await resolveResumePdf(row, profile, mkApply(), dir);
    expect(out).toEqual({ ok: false, reason: expect.stringContaining("chromium down") });
  });
});
