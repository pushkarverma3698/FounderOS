import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobApplication } from "../../../src/db/schema.js";
import type { FormPlanSummary } from "../../../src/tools/jobhunt/form-filled.js";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { runAutoSend } = await import("../../../src/gateway/apply-auto-send.js");
const { tryLockApply, clearAutoApplySessionsForTests } = await import("../../../src/gateway/apply-session.js");
type Deps = Parameters<typeof runAutoSend>[3];

const row = { id: "r1", company: "Acme", title: "Engineer" };
const full = { ...row, profile_id: "p1" } as JobApplication;
const clean = { filled: 1, total: 1, filledLabels: [], filledAnswers: [], unanswered: [], requiredUnanswered: [], hasCaptcha: false, readyToSubmit: true } as FormPlanSummary;
const letterForm = { ...clean, requiredUnanswered: [{ selector: "#c", label: "Cover letter", kind: "ask", question: "c", required: true, fieldType: "textarea", why: "w" }] } as FormPlanSummary;

function deps(over: Partial<NonNullable<Deps>> = {}) {
  const texts: string[] = [];
  const d = {
    chatId: () => "chat1",
    loadRow: vi.fn(async () => full),
    letter: vi.fn(async () => ({ ok: true })),
    reserve: vi.fn(async () => true),
    submit: vi.fn(async (...args: unknown[]) => {
      const io = args[3] as { photo: (b: Buffer, c: string, f: string) => Promise<void> };
      await io.photo(Buffer.from("png"), "proof", "p.png");
      return { kind: "confirmed" as const, row: full, detail: "Application submitted and marked applied." };
    }),
    record: vi.fn(async () => undefined),
    text: vi.fn(async (_c: string, html: string) => { texts.push(html); }),
    photo: vi.fn(async () => undefined),
    ...over,
  } as NonNullable<Deps>;
  return { d, texts };
}

afterEach(() => clearAutoApplySessionsForTests());

describe("runAutoSend", () => {
  it("sends through runSubmit as via=auto, records the result, tells the chat and passes the proof photo", async () => {
    const { d, texts } = deps();
    const out = await runAutoSend(row, "p1", clean, d);
    expect(out).toMatchObject({ kind: "sent", result: "confirmed" });
    expect(vi.mocked(d.reserve).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(d.submit).mock.invocationCallOrder[0] ?? 0);
    expect(d.submit).toHaveBeenCalledWith("r1", "chat1", "auto", expect.anything());
    expect(d.photo).toHaveBeenCalledWith("chat1", expect.any(Buffer), "proof", "p.png");
    expect(d.record).toHaveBeenCalledWith("r1", "p1", "confirmed", expect.any(String));
    expect(texts.at(-1)).toContain("Auto-sent");
    expect(texts.at(-1)).toContain("Acme");
    expect(texts.at(-1)).toContain("confirmed");
  });
  it("does not send when a required cover letter has no clean letter, and does not reserve", async () => {
    const { d } = deps({ letter: vi.fn(async () => ({ ok: false, reason: "failed fact check" })) });
    const out = await runAutoSend(row, "p1", letterForm, d);
    expect(out).toMatchObject({ kind: "no-letter" });
    expect(d.reserve).not.toHaveBeenCalled();
    expect(d.submit).not.toHaveBeenCalled();
  });
  it("does not ask for a letter when the form does not require one", async () => {
    const { d } = deps();
    await runAutoSend(row, "p1", clean, d);
    expect(d.letter).not.toHaveBeenCalled();
  });
  it("never repeats an attempt: a reserved row is not sent", async () => {
    const { d } = deps({ reserve: vi.fn(async () => false) });
    expect(await runAutoSend(row, "p1", clean, d)).toMatchObject({ kind: "skipped" });
    expect(d.submit).not.toHaveBeenCalled();
  });
  it("reports an unconfirmed click, records it, and a second call does not click again", async () => {
    let reserved = false;
    const { d, texts } = deps({
      reserve: vi.fn(async () => { if (reserved) return false; reserved = true; return true; }),
      submit: vi.fn(async () => ({ kind: "unconfirmed" as const, row: full, detail: "no confirmation page" })),
    });
    expect(await runAutoSend(row, "p1", clean, d)).toMatchObject({ kind: "sent", result: "unconfirmed" });
    expect(texts.at(-1)).toContain("unconfirmed, not retried");
    expect(await runAutoSend(row, "p1", clean, d)).toMatchObject({ kind: "skipped" });
    expect(d.submit).toHaveBeenCalledTimes(1);
  });
  it("skips a row another run holds the lock on", async () => {
    const release = tryLockApply("r1", Date.now(), "submit");
    const { d } = deps();
    expect(await runAutoSend(row, "p1", clean, d)).toMatchObject({ kind: "skipped" });
    expect(d.reserve).not.toHaveBeenCalled();
    release?.();
  });
  it("releases the lock afterwards", async () => {
    const { d } = deps();
    await runAutoSend(row, "p1", clean, d);
    const again = tryLockApply("r1", Date.now(), "submit");
    expect(again).not.toBeNull();
    again?.();
  });
  it("records and reports a crash after the attempt, and does not rethrow", async () => {
    const { d, texts } = deps({ submit: vi.fn(async () => { throw new Error("browser died"); }) });
    expect(await runAutoSend(row, "p1", clean, d)).toMatchObject({ kind: "sent", result: "failed" });
    expect(d.record).toHaveBeenCalledWith("r1", "p1", "error", "browser died");
    expect(texts.at(-1)).toContain("crashed");
  });
  it("reports a refusal from the send path as not sent", async () => {
    const { d, texts } = deps({ submit: vi.fn(async () => ({ kind: "refused" as const, toast: "Already applied" })) });
    expect(await runAutoSend(row, "p1", clean, d)).toMatchObject({ kind: "sent", result: "refused" });
    expect(texts.at(-1)).toContain("refused before sending");
  });
});
