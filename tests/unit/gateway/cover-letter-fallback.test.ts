/**
 * An empty model result falls back to the letter /draft archived for the row;
 * any other failure does not (a letter that broke the fact rules must not be replaced by an older one).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobApplication } from "../../../src/db/schema.js";

const mockBuild = vi.fn();
const mockDownload = vi.fn();

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/tools/jobhunt/cover-letter.js", () => ({ buildCoverLetter: (...a: unknown[]) => mockBuild(...a) }));
vi.mock("../../../src/agents/worker-invoke.js", () => ({ invokeWorkerWithFallbacks: vi.fn() }));
vi.mock("../../../src/infra/storage/s3-client.js", () => ({
  downloadFile: (...a: unknown[]) => mockDownload(...a),
  uploadFile: vi.fn(async () => "key"),
}));
vi.mock("../../../src/db/job-queries.js", () => ({ recordTailoringResult: vi.fn() }));
vi.mock("../../../src/tools/jobhunt/apply-profile.js", () => ({
  applyProfilePathFor: () => "/nonexistent",
  readApplyProfile: async () => ({ ok: false, reason: "none" }),
}));
vi.mock("../../../src/tools/jobhunt/candidate-dossier.js", () => ({ readCandidateDossier: async () => null }));

const { writeCoverLetter } = await import("../../../src/gateway/cover-letter-delivery.js");

const row = (key: string | null): JobApplication =>
  ({ id: "r1", company: "Acme", title: "Engineer", description: "x", track: "backend", profile_id: "p", country: "IN", cover_letter_s3_key: key }) as JobApplication;

describe("writeCoverLetter fallback", () => {
  beforeEach(() => {
    mockBuild.mockReset();
    mockDownload.mockReset();
  });

  it("passes the row's country to the builder", async () => {
    mockBuild.mockResolvedValue({ success: true, letter: "L" });
    await writeCoverLetter(row(null), "cv");
    expect(mockBuild.mock.calls[0]?.[0]).toMatchObject({ postingCountry: "IN" });
  });

  it("uses the archived /draft letter when the model returned nothing", async () => {
    mockBuild.mockResolvedValue({ success: false, kind: "empty", error: "0 characters" });
    mockDownload.mockResolvedValue(Buffer.from("Archived letter"));
    expect(await writeCoverLetter(row("k"), "cv")).toEqual({ ok: true, letter: "Archived letter" });
  });

  it("returns the plain reason when nothing is archived", async () => {
    mockBuild.mockResolvedValue({ success: false, kind: "empty", error: "0 characters" });
    expect(await writeCoverLetter(row(null), "cv")).toEqual({ ok: false, reason: "0 characters" });
  });

  it("does not fall back on a fact failure", async () => {
    mockBuild.mockResolvedValue({ success: false, kind: "facts", error: "relocation" });
    mockDownload.mockResolvedValue(Buffer.from("Archived letter"));
    expect(await writeCoverLetter(row("k"), "cv")).toEqual({ ok: false, reason: "relocation" });
    expect(mockDownload).not.toHaveBeenCalled();
  });
});
