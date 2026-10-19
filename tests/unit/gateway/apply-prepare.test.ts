/**
 * prepareRow: the grammy-free core of /apply (apply-prepare.ts). Proves each refusal is typed and carries a chat line
 * and a plain sentence, that nothing is locked or sent on a refusal, that a started run sends the usual opening lines
 * and releases the lock it took (or was handed), and that startAutoApplyForRow still replies to the chat as before.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobApplication } from "../../../src/db/schema.js";
import type { JobSearchProfile } from "../../../src/tools/jobhunt/profile-config.js";

const mockReadApplyProfile = vi.fn();
const mockResolveResumePdf = vi.fn();
const mockResolveCoverLetter = vi.fn();
const mockRunForm = vi.fn(async (..._a: unknown[]) => undefined);

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/tools/jobhunt/apply-profile.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/tools/jobhunt/apply-profile.js")>()),
  readApplyProfile: (...a: unknown[]) => mockReadApplyProfile(...a),
}));
vi.mock("../../../src/gateway/apply-material.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/gateway/apply-material.js")>()),
  resolveResumePdf: (...a: unknown[]) => mockResolveResumePdf(...a),
  resolveCoverLetter: (...a: unknown[]) => mockResolveCoverLetter(...a),
}));
vi.mock("../../../src/gateway/apply-flow.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/gateway/apply-flow.js")>()),
  runFormPrepAndPrompt: (...a: unknown[]) => mockRunForm(...a),
}));

const { prepareRow } = await import("../../../src/gateway/apply-prepare.js");
const { startAutoApplyForRow } = await import("../../../src/gateway/auto-apply.js");
const { clearAutoApplySessionsForTests, lockPhase, tryLockApply } = await import("../../../src/gateway/apply-session.js");
const { getProfile } = await import("../../../src/tools/jobhunt/profile-config.js");

const profile: JobSearchProfile = getProfile("pushkar-nl-tech");
const baseRow = {
  id: "11111111-2222-4333-8444-555555555555", profile_id: "pushkar-nl-tech", company: "Workwize", title: "Automation Engineer",
  url: "https://jobs.ashbyhq.com/workwize/1", stage: "drafted", applied_at: null,
} as unknown as JobApplication;

function sender() {
  const lines: string[] = [];
  return { lines, send: { text: vi.fn(async (html: string) => void lines.push(html)) } };
}

describe("prepareRow", () => {
  beforeEach(() => {
    clearAutoApplySessionsForTests();
    mockRunForm.mockClear();
    mockReadApplyProfile.mockReset().mockResolvedValue({ ok: true, profile: { first_name: "P" } });
    mockResolveResumePdf.mockReset().mockResolvedValue({ ok: true, pdfPath: "/tmp/cv.pdf" });
    mockResolveCoverLetter.mockReset().mockResolvedValue({ ok: false, reason: "no letter" });
  });

  it("refuses an already applied row without locking or sending", async () => {
    const { send, lines } = sender();
    const r = await prepareRow({ ...baseRow, applied_at: new Date("2026-10-01T00:00:00Z") }, profile, "111", send);
    expect(r).toMatchObject({ kind: "refused", reason: "already-applied" });
    if (r.kind === "refused") expect(r.detail).toContain("2026-10-01");
    expect(lines).toEqual([]);
    expect(lockPhase(baseRow.id)).toBeNull();
  });

  it("refuses when the apply profile is unusable", async () => {
    mockReadApplyProfile.mockResolvedValue({ ok: false, reason: "file missing" });
    const r = await prepareRow(baseRow, profile, "111", sender().send);
    expect(r).toMatchObject({ kind: "refused", reason: "no-profile" });
    if (r.kind === "refused") expect(r.detail).toContain("file missing");
  });

  it("refuses when there is no resume", async () => {
    mockResolveResumePdf.mockResolvedValue({ ok: false, reason: "no CV on disk" });
    const r = await prepareRow(baseRow, profile, "111", sender().send);
    expect(r).toMatchObject({ kind: "refused", reason: "no-resume" });
    if (r.kind === "refused") expect(r.detail).toContain("no CV on disk");
  });

  it("refuses when the row has no application URL", async () => {
    const r = await prepareRow({ ...baseRow, url: null }, profile, "111", sender().send);
    expect(r).toMatchObject({ kind: "refused", reason: "no-url" });
  });

  it("refuses while another run holds the row's lock, and leaves that lock alone", async () => {
    const other = tryLockApply(baseRow.id);
    const { send, lines } = sender();
    const r = await prepareRow(baseRow, profile, "111", send);
    expect(r).toMatchObject({ kind: "refused", reason: "lock-held" });
    expect(lines).toEqual([]);
    expect(lockPhase(baseRow.id)).toBe("prepare");
    other?.();
  });

  it("starts: sends the opening line, hands the form run the lock to release, and keeps no lock of its own", async () => {
    const { send, lines } = sender();
    const r = await prepareRow(baseRow, profile, "111", send);
    expect(r).toEqual({ kind: "started" });
    expect(lines[0]).toContain("Opening Workwize");
    expect(mockRunForm).toHaveBeenCalledTimes(1);
    const release = mockRunForm.mock.calls[0]?.[2] as () => void;
    expect(lockPhase(baseRow.id)).toBe("prepare"); // the form run owns it until it finishes
    release();
    expect(lockPhase(baseRow.id)).toBeNull();
  });

  it("uses a lock the caller already holds and frees it when it refuses", async () => {
    const held = tryLockApply(baseRow.id);
    expect(held).not.toBeNull();
    const r = await prepareRow({ ...baseRow, url: null }, profile, "111", sender().send, { held: held! });
    expect(r).toMatchObject({ kind: "refused", reason: "no-url" });
    expect(lockPhase(baseRow.id)).toBeNull();

    const held2 = tryLockApply(baseRow.id)!;
    await prepareRow(baseRow, profile, "111", sender().send, { held: held2 });
    expect(mockRunForm).toHaveBeenCalledTimes(1);
    (mockRunForm.mock.calls[0]?.[2] as () => void)();
    expect(lockPhase(baseRow.id)).toBeNull();
  });

  it("lets a form-run crash reach the caller (runFormPrepAndPrompt owns the release from the call on)", async () => {
    mockRunForm.mockRejectedValueOnce(new Error("boom"));
    await expect(prepareRow(baseRow, profile, "111", sender().send)).rejects.toThrow("boom");
  });
});

describe("startAutoApplyForRow (chat behaviour)", () => {
  beforeEach(() => {
    clearAutoApplySessionsForTests();
    mockRunForm.mockClear();
    mockReadApplyProfile.mockReset().mockResolvedValue({ ok: true, profile: { first_name: "P" } });
    mockResolveResumePdf.mockReset().mockResolvedValue({ ok: true, pdfPath: "/tmp/cv.pdf" });
    mockResolveCoverLetter.mockReset().mockResolvedValue({ ok: false, reason: "no letter" });
  });
  const fakeCtx = () => ({
    chat: { id: 999, type: "private" },
    reply: vi.fn(async (..._a: unknown[]) => undefined),
  });

  it("replies with the refusal line as HTML, as before", async () => {
    const ctx = fakeCtx();
    await startAutoApplyForRow(ctx as never, { ...baseRow, url: null }, profile);
    expect(ctx.reply).toHaveBeenCalledWith("⚠ Workwize has no application URL on file.", { parse_mode: "HTML" });
  });

  it("replies once with the lock-held line while a run is in flight", async () => {
    const other = tryLockApply(baseRow.id);
    const ctx = fakeCtx();
    await startAutoApplyForRow(ctx as never, baseRow, profile);
    expect(ctx.reply).toHaveBeenCalledTimes(1);
    expect(String(ctx.reply.mock.calls[0]?.[0])).toContain("already re-filling");
    other?.();
  });

  it("writes the opening line to the chat and starts the form run", async () => {
    const ctx = fakeCtx();
    await startAutoApplyForRow(ctx as never, baseRow, profile);
    expect(String(ctx.reply.mock.calls[0]?.[0])).toContain("Opening Workwize");
    expect(mockRunForm).toHaveBeenCalledTimes(1);
  });
});
