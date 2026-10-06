/**
 * The Draft button answers from storage when the morning pre-tailor step already built the role.
 * Real files in a temp dir; storage and the model path are fakes, so this costs nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const s3 = vi.hoisted(() => ({ downloadFile: vi.fn(), uploadFile: vi.fn() }));
vi.mock("../../../src/infra/storage/s3-client.js", () => s3);
const packet = vi.hoisted(() => ({ buildApplicationPacket: vi.fn() }));
vi.mock("../../../src/tools/jobhunt/apply-packet.js", async (orig) => ({ ...(await orig<object>()), ...packet }));

import { sendStoredDraft, applyLinkLine } from "../../../src/gateway/jobhunt-stored-draft.js";
import { draftRow } from "../../../src/gateway/jobhunt-commands.js";
import type { JobApplication } from "../../../src/db/schema.js";
import type { JobSearchProfile } from "../../../src/tools/jobhunt/profile-config.js";

const ROW = {
  id: "00000000-0000-4000-8000-000000000001",
  company: "Acme B.V.",
  title: "Backend Engineer",
  route: "highly skilled migrant",
  url: "https://boards.greenhouse.io/acme/jobs/123",
  tailored_cv_s3_key: "ready/acme/cv.pdf",
  cover_letter_s3_key: "ready/acme/letter.txt",
} as unknown as JobApplication;

function fakeCtx() {
  const sent: string[] = [];
  const ctx = {
    chat: { id: 1 },
    reply: vi.fn(async (text: string) => { sent.push("text:" + text); }),
    replyWithDocument: vi.fn(async () => { sent.push("document"); }),
  };
  return { ctx: ctx as never, sent };
}

const io = (over: Record<string, Buffer | Error> = {}) => ({
  download: async (key: string) => {
    const v = over[key] ?? (key.endsWith("pdf") ? Buffer.from("%PDF-1.7 fake") : Buffer.from("Dear Hiring Team, hello."));
    if (v instanceof Error) throw v;
    return v;
  },
});

let dir: string;
beforeEach(async () => {
  vi.clearAllMocks();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "stored-draft-"));
});

describe("sendStoredDraft", () => {
  it("does nothing for a role with no stored CV, so the caller tailors as before", async () => {
    const { ctx, sent } = fakeCtx();
    const download = vi.fn();
    const res = await sendStoredDraft(ctx, { ...ROW, tailored_cv_s3_key: null }, dir, 1, { download });
    expect(res).toBe(false);
    expect(sent).toEqual([]);
    expect(download).not.toHaveBeenCalled();
  });
  it("sends the letter, the stored PDF and the apply message, with no tailoring wait", async () => {
    const { ctx, sent } = fakeCtx();
    expect(await sendStoredDraft(ctx, ROW, dir, 1, io())).toBe(true);
    expect(sent[0]).toContain("Already tailored");
    expect(sent[1]).toContain("Dear Hiring Team");
    expect(sent[2]).toBe("document");
    expect(sent[3]).toContain("<b>1. Acme B.V.");
    expect(sent.join("\n")).not.toContain("Tailoring your CV");
    expect((await fs.readdir(dir)).some((f) => f.endsWith(".pdf"))).toBe(true);
  });
  it("says so when the letter was never stored, and still sends the CV", async () => {
    const { ctx, sent } = fakeCtx();
    expect(await sendStoredDraft(ctx, { ...ROW, cover_letter_s3_key: null }, dir, undefined, io())).toBe(true);
    expect(sent.join("\n")).toContain("No cover letter was stored");
    expect(sent).toContain("document");
  });
  it("falls back, having sent nothing, when the stored CV cannot be read", async () => {
    const { ctx, sent } = fakeCtx();
    const res = await sendStoredDraft(ctx, ROW, dir, 1, io({ "ready/acme/cv.pdf": new Error("NoSuchKey") }));
    expect(res).toBe(false);
    expect(sent).toEqual([]);
  });
  it("never reads an empty file as a CV", async () => {
    const { ctx, sent } = fakeCtx();
    expect(await sendStoredDraft(ctx, ROW, dir, 1, io({ "ready/acme/cv.pdf": Buffer.alloc(0) }))).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("applyLinkLine", () => {
  it("warns when there is no URL, and says when the ATS hides the form", () => {
    expect(applyLinkLine("", false)).toContain("No URL on file");
    expect(applyLinkLine("https://x.test", false)).toContain("hides the form");
    expect(applyLinkLine("https://x.test", true)).not.toContain("hides the form");
  });
});

describe("draftRow with a stored CV", () => {
  it("returns the stored file and never starts a fresh tailoring run", async () => {
    s3.downloadFile.mockImplementation(async (key: string) => (key.endsWith("pdf") ? Buffer.from("%PDF-1.7 fake") : Buffer.from("Dear Hiring Team")));
    const { ctx, sent } = fakeCtx();
    const runKernelText = vi.fn();
    await draftRow(ctx, ROW, { runKernelText }, "", { id: "pushkar-nl-tech", tenantId: "turicks" } as unknown as JobSearchProfile, 1);
    expect(packet.buildApplicationPacket).not.toHaveBeenCalled();
    expect(runKernelText).not.toHaveBeenCalled();
    expect(sent).toContain("document");
    expect(sent.join("\n")).not.toContain("Tailoring your CV");
  });
});
