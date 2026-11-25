/**
 * The Mac lease never hands out a row with an open required question (seen live 2026-11-23: it burned a mac_attempt on a
 * form the worker cannot answer). The snapshot loader is mocked; rows with no snapshot stay eligible.
 */

import { describe, expect, it, vi } from "vitest";
import type { ApplySnapshot } from "../../../src/tools/jobhunt/apply-link.js";

vi.mock("../../../src/infra/logger.js", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
const loadApplySnapshot = vi.fn<(rowId: string, root?: string) => ApplySnapshot | null>();
vi.mock("../../../src/tools/jobhunt/apply-link.js", async (orig) => ({ ...(await orig<object>()), loadApplySnapshot }));

const { hasOpenRequiredQuestion } = await import("../../../src/gateway/apply-queue-api.js");
const { defaultMacWorkerDeps } = await import("../../../src/gateway/mac-worker-api.js");

const q = (required: boolean) => ({ label: "Why us?", fieldType: "textarea", required, source: "unknown", editable: true });
const snap = (unanswered: unknown[]): ApplySnapshot =>
  ({ rowId: "r", summary: { filled: 1, total: 2, hasCaptcha: true, filledLabels: [], filledAnswers: [], unanswered } }) as unknown as ApplySnapshot;

describe("open required question", () => {
  it("is true only for an unanswered required question", () => {
    expect(hasOpenRequiredQuestion(null)).toBe(false);
    expect(hasOpenRequiredQuestion(snap([]))).toBe(false);
    expect(hasOpenRequiredQuestion(snap([q(false)]))).toBe(false);
    expect(hasOpenRequiredQuestion(snap([q(false), q(true)]))).toBe(true);
  });

  it("the default Mac deps skip a row whose snapshot has one, and keep a row with none or no snapshot", () => {
    loadApplySnapshot.mockImplementation((id) => (id === "open" ? snap([q(true)]) : id === "clean" ? snap([]) : null));
    const { hasOpenQuestion } = defaultMacWorkerDeps();
    expect(hasOpenQuestion("open")).toBe(true);
    expect(hasOpenQuestion("clean")).toBe(false);
    expect(hasOpenQuestion("nosnap")).toBe(false);
  });
});
