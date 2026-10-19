/**
 * The shared Submit path (ADR-018): one function behind the Telegram button and the Mini App.
 * Proves, with a scripted form runner and a mocked audit table:
 *  1. a confirmed send marks the row applied, ends the session and writes ONE audit row keyed apply-submit:<rowId>;
 *  2. a row that is already audited is refused before anything is sent;
 *  3. an unconfirmed click sends once, writes no audit row, and the guard survives a restart (it lives in the snapshot);
 *  4. a failed send writes no audit row and leaves Submit available; a lost audit row does not undo a sent application.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROW_ID = "11111111-2222-4333-8444-555555555555";

const mockMarkRowApplied = vi.fn(async (_row?: unknown) => ({ ok: true as const, already: false }));
const mockGetApplicationById = vi.fn();
const mockHasBeenAudited = vi.fn(async (_key: string) => false);
const mockWriteAuditEntry = vi.fn(async (_data: unknown) => ({ written: true }));

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
  hasBeenAudited: (key: string) => mockHasBeenAudited(key),
  writeAuditEntry: (data: unknown) => mockWriteAuditEntry(data),
}));

const { runSubmit, auditKeyFor } = await import("../../../src/gateway/apply-submit.js");
const { clearAutoApplySessionsForTests, setAutoApplyRunnerForTests, unconfirmedClickAt } = await import("../../../src/gateway/apply-session.js");
const { holdForEmailCode, releaseHeld, heldCodeInfo } = await import("../../../src/tools/jobhunt/held-submit.js");
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

const sendResult = (confirmed: boolean) => ({
  ok: true as const,
  platform: "greenhouse",
  clicked: true,
  confirmed,
  evidence: confirmed ? "Confirmed: Thank you for applying" : "No confirmation text",
  afterScreenshotPng: Buffer.from("png"),
});

describe("runSubmit", () => {
  let tmpDir: string;
  let submitCalls: number;

  function runner(result: () => unknown): void {
    setAutoApplyRunnerForTests({
      coverLetter: async () => ({ ok: false, reason: "not in this test" }),
      submit: (async () => {
        submitCalls += 1;
        return result();
      }) as never,
    } as never);
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "founderos-apply-submit-"));
    const cv = path.join(tmpDir, "cv.pdf");
    await fs.writeFile(cv, Buffer.from("%PDF-1.4 cv"));
    const profilePath = path.join(tmpDir, "apply-profile.json");
    await fs.writeFile(profilePath, JSON.stringify({ first_name: "P", last_name: "V", email: "p@example.com", phone: "1", default_resume: cv, answers: {} }));
    process.env["APPLY_PROFILE_PATH"] = profilePath;
    process.env["FOUNDEROS_DATA_ROOT"] = tmpDir;
    clearAutoApplySessionsForTests();
    saveApplySnapshot(snapshot);
    mockMarkRowApplied.mockClear();
    mockGetApplicationById.mockReset().mockResolvedValue(row);
    mockHasBeenAudited.mockReset().mockResolvedValue(false);
    mockWriteAuditEntry.mockReset().mockResolvedValue({ written: true });
    submitCalls = 0;
  });

  afterEach(async () => {
    await releaseHeld(ROW_ID);
    setAutoApplyRunnerForTests(undefined);
    delete process.env["FOUNDEROS_DATA_ROOT"];
    delete process.env["APPLY_PROFILE_PATH"];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("confirmed: marks applied, writes one audit row keyed apply-submit:<rowId>, and ends the session", async () => {
    runner(() => sendResult(true));
    const { io, texts, photos } = recorder();
    const result = await runSubmit(ROW_ID, "777", "miniapp", io);
    expect(result.kind).toBe("confirmed");
    expect(mockMarkRowApplied).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEntry).toHaveBeenCalledTimes(1);
    const audit = mockWriteAuditEntry.mock.calls[0]?.[0] as { idempotency_key: string; payload: { via: string; rowId: string } };
    expect(audit.idempotency_key).toBe(auditKeyFor(ROW_ID));
    expect(audit.idempotency_key).toBe(`apply-submit:${ROW_ID}`);
    expect(audit.payload).toMatchObject({ via: "miniapp", rowId: ROW_ID });
    expect(loadApplySnapshot(ROW_ID)).toBeNull();
    expect(photos).toHaveLength(1);
    expect(texts.some((t) => t.includes("Application submitted and marked applied"))).toBe(true);
    expect(io.started).toHaveBeenCalledTimes(1);
    expect(io.settled).toHaveBeenCalledTimes(1);
  });

  it("refuses before sending when the row already has an audit row", async () => {
    runner(() => sendResult(true));
    mockHasBeenAudited.mockResolvedValue(true);
    const { io } = recorder();
    const result = await runSubmit(ROW_ID, "777", "telegram", io);
    expect(result).toMatchObject({ kind: "refused", toast: "Already submitted" });
    expect(mockHasBeenAudited).toHaveBeenCalledWith(`apply-submit:${ROW_ID}`);
    expect(submitCalls).toBe(0);
    expect(mockMarkRowApplied).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
  });

  it("sends nothing when the audit table cannot be read", async () => {
    runner(() => sendResult(true));
    mockHasBeenAudited.mockRejectedValue(new Error("db down"));
    const result = await runSubmit(ROW_ID, "777", "telegram", recorder().io);
    expect(result.kind).toBe("refused");
    expect(submitCalls).toBe(0);
  });

  it("unconfirmed: no audit row, and a second Submit is refused, also after a restart", async () => {
    runner(() => sendResult(false));
    const first = await runSubmit(ROW_ID, "777", "miniapp", recorder().io);
    expect(first.kind).toBe("unconfirmed");
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    expect(mockMarkRowApplied).not.toHaveBeenCalled();
    expect(submitCalls).toBe(1);

    clearAutoApplySessionsForTests(); // a restart: memory is gone, the snapshot file is not
    expect(unconfirmedClickAt(ROW_ID)).toBeInstanceOf(Date);
    expect(loadApplySnapshot(ROW_ID)?.unconfirmedAt).toBeTypeOf("number");
    const second = await runSubmit(ROW_ID, "777", "telegram", recorder().io);
    expect(second).toMatchObject({ kind: "refused", toast: "Already sent once" });
    expect(submitCalls).toBe(1);
  });

  it("a failed send writes no audit row and does not remember a click", async () => {
    runner(() => ({ ok: false, reason: "form changed" }));
    const result = await runSubmit(ROW_ID, "777", "telegram", recorder().io);
    expect(result).toMatchObject({ kind: "failed", detail: "form changed" });
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    expect(unconfirmedClickAt(ROW_ID)).toBeUndefined();
  });

  it("a lost audit row does not undo a sent application", async () => {
    runner(() => sendResult(true));
    mockWriteAuditEntry.mockRejectedValue(new Error("db down"));
    const result = await runSubmit(ROW_ID, "777", "telegram", recorder().io);
    expect(result.kind).toBe("confirmed");
    expect(mockMarkRowApplied).toHaveBeenCalledTimes(1);
  });

  it("code-needed: not applied, no unconfirmed click, one chat line telling him to type the code, and a second Submit is refused", async () => {
    runner(() => {
      holdForEmailCode(ROW_ID, { page: {} as never, browser: { close: async () => undefined }, dialog: { message: null }, findSubmit: async () => null });
      return { ...sendResult(false), evidence: "Greenhouse asked for the emailed code", codeNeeded: true };
    });
    const { io, texts } = recorder();
    const result = await runSubmit(ROW_ID, "777", "telegram", io);
    expect(result.kind).toBe("code-needed");
    expect(mockMarkRowApplied).not.toHaveBeenCalled();
    expect(mockWriteAuditEntry).not.toHaveBeenCalled();
    expect(unconfirmedClickAt(ROW_ID)).toBeUndefined();
    expect(loadApplySnapshot(ROW_ID)?.unconfirmedAt).toBeUndefined();
    expect(io.settled).not.toHaveBeenCalled();
    const codeLines = texts.filter((t) => t.includes("code"));
    expect(codeLines).toHaveLength(1);
    expect(codeLines[0]).toContain("Open the form and type it");
    expect(heldCodeInfo(ROW_ID)).not.toBeNull();
    const again = await runSubmit(ROW_ID, "777", "telegram", recorder().io);
    expect(again).toMatchObject({ kind: "refused", toast: "Waiting for your emailed code" });
    expect(submitCalls).toBe(1);
  });

  it("code-needed escapes the company name in the chat line", async () => {
    mockGetApplicationById.mockResolvedValue({ ...row, company: "A<b>&Co" });
    runner(() => ({ ...sendResult(false), codeNeeded: true }));
    const { io, texts } = recorder();
    await runSubmit(ROW_ID, "777", "telegram", io);
    expect(texts.join("\n")).toContain("A&lt;b&gt;&amp;Co");
    expect(texts.join("\n")).not.toContain("A<b>&Co");
  });
});
