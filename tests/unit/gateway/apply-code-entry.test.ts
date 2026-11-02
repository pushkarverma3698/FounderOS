/**
 * runCodeEntry (ADR-018, 2026-10-18 amendment): the founder typed the emailed Greenhouse code.
 * The browser step is scripted (enterEmailCode is covered against real Chromium in held-submit.test.ts). Proves:
 *  1. a confirmed code takes the same path as a confirmed send: marked applied, ONE audit row apply-submit:<rowId>, session ended;
 *  2. a wrong code keeps everything open: nothing applied, no unconfirmed click, no chat line;
 *  3. an unconfirmed result (timeout, page gone) remembers the click with a plain reason and never marks applied;
 *  4. nothing held, a malformed code and a missing row answer without touching the audit table.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROW_ID = "11111111-2222-4333-8444-555555555555";

const mockMarkRowApplied = vi.fn(async (_row?: unknown) => ({ ok: true as const, already: false }));
const mockGetApplicationById = vi.fn();
const mockWriteAuditEntry = vi.fn(async (_data: unknown) => ({ written: true }));
const mockEnter = vi.fn();

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../../../src/gateway/jobhunt-buttons.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/gateway/jobhunt-buttons.js")>()),
  markRowApplied: (row: unknown) => mockMarkRowApplied(row),
}));
vi.mock("../../../src/db/apply-queries.js", () => ({
  getApplicationById: (...args: unknown[]) => mockGetApplicationById(...args),
}));
vi.mock("../../../src/db/queries.js", () => ({
  hasBeenAudited: async () => false,
  writeAuditEntry: (data: unknown) => mockWriteAuditEntry(data),
}));
vi.mock("../../../src/tools/jobhunt/held-submit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/tools/jobhunt/held-submit.js")>()),
  enterEmailCode: (...args: unknown[]) => mockEnter(...args),
}));

const { runCodeEntry, auditKeyFor } = await import("../../../src/gateway/apply-submit.js");
const { clearAutoApplySessionsForTests, unconfirmedClickAt } = await import("../../../src/gateway/apply-session.js");
const { saveApplySnapshot, loadApplySnapshot } = await import("../../../src/tools/jobhunt/apply-link.js");

const row = {
  id: ROW_ID,
  company: "Workwize",
  title: "Automation Engineer",
  url: "https://job-boards.eu.greenhouse.io/workwize/jobs/1",
  profile_id: "pushkar-nl-tech",
  track: "fullstack",
  stage: "screened",
};

const snapshot = {
  rowId: ROW_ID,
  chatId: "777",
  profileId: "pushkar-nl-tech",
  company: "Workwize",
  title: "Automation Engineer",
  candidateName: "Pushkar Verma",
  targetUrl: row.url,
  platform: "greenhouse",
  resumePath: "cv.pdf",
  summary: { filled: 5, total: 5, hasCaptcha: false, filledLabels: [], filledAnswers: [], unanswered: [] },
  createdAt: 1,
} as never;

function recorder() {
  const texts: string[] = [];
  const photos: string[] = [];
  return {
    texts,
    photos,
    io: {
      text: async (html: string) => void texts.push(html),
      photo: async (_png: Buffer, caption: string) => void photos.push(caption),
      started: vi.fn(async () => undefined),
      settled: vi.fn(async () => undefined),
    },
  };
}

const png = Buffer.from("png");

describe("runCodeEntry", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "founderos-apply-code-"));
    process.env["FOUNDEROS_DATA_ROOT"] = tmpDir;
    clearAutoApplySessionsForTests();
    saveApplySnapshot(snapshot);
    mockMarkRowApplied.mockClear();
    mockWriteAuditEntry.mockReset().mockResolvedValue({ written: true });
    mockGetApplicationById.mockReset().mockResolvedValue(row);
    mockEnter.mockReset();
  });

  afterEach(async () => {
    delete process.env["FOUNDEROS_DATA_ROOT"];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("confirmed: marks applied, writes one audit row, ends the session, sends the proof screenshot", async () => {
    mockEnter.mockResolvedValue({ kind: "confirmed", evidence: "Confirmed: Thank you", screenshotPng: png });
    const { io, texts, photos } = recorder();
    const result = await runCodeEntry(ROW_ID, "miniapp", "AB12cd34", io);
    expect(result.kind).toBe("confirmed");
    expect(mockEnter).toHaveBeenCalledWith(ROW_ID, "AB12cd34");
    expect(mockMarkRowApplied).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    const audit = mockWriteAuditEntry.mock.calls[0]?.[0] as { idempotency_key: string; payload: { via: string } };
    expect(audit.idempotency_key).toBe(auditKeyFor(ROW_ID));
    expect(audit.payload.via).toBe("miniapp");
    expect(loadApplySnapshot(ROW_ID)).toBeNull();
    expect(photos).toHaveLength(1);
    expect(texts.some((t) => t.includes("Application submitted and marked applied"))).toBe(true);
    expect(io.settled).toHaveBeenCalledTimes(1);
  });

  it("a wrong code changes nothing: not applied, no unconfirmed click, no chat line, still re-enterable", async () => {
    mockEnter.mockResolvedValue({ kind: "code-needed", evidence: "That code was not accepted.", screenshotPng: png });
    const { io, texts } = recorder();
    const result = await runCodeEntry(ROW_ID, "miniapp", "WRONG123", io);
    expect(result).toMatchObject({ kind: "code-needed", detail: "That code was not accepted." });
    expect(mockMarkRowApplied).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    expect(unconfirmedClickAt(ROW_ID)).toBeUndefined();
    expect(texts).toHaveLength(0);
    expect(io.settled).not.toHaveBeenCalled();
    expect(loadApplySnapshot(ROW_ID)).not.toBeNull();
  });

  it("unconfirmed: remembers the click, never marks applied, and says why in plain words", async () => {
    mockEnter.mockResolvedValue({ kind: "unconfirmed", evidence: "No confirmation after the code.", screenshotPng: png });
    const { io, texts } = recorder();
    const result = await runCodeEntry(ROW_ID, "telegram", "AB12cd34", io);
    expect(result.kind).toBe("unconfirmed");
    expect(mockMarkRowApplied).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    expect(unconfirmedClickAt(ROW_ID)).toBeInstanceOf(Date);
    expect(texts.join("\n")).toContain("No confirmation after the code.");
  });

  it("nothing held, or a malformed code, or a missing row: answers without any write", async () => {
    mockEnter.mockResolvedValueOnce({ kind: "none" });
    expect(await runCodeEntry(ROW_ID, "miniapp", "AB12cd34", recorder().io)).toMatchObject({ kind: "none" });
    mockEnter.mockResolvedValueOnce({ kind: "invalid", reason: "The code is 4 to 12 letters and digits." });
    expect(await runCodeEntry(ROW_ID, "miniapp", "!", recorder().io)).toMatchObject({ kind: "invalid", detail: "The code is 4 to 12 letters and digits." });
    mockGetApplicationById.mockResolvedValue(undefined);
    expect(await runCodeEntry(ROW_ID, "miniapp", "AB12cd34", recorder().io)).toMatchObject({ kind: "none" });
    expect(mockMarkRowApplied).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });
});
