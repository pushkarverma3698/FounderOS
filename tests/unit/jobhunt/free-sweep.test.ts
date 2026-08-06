/**
 * Unit tests — the free lane's cron entrypoint (`runFreeSweep`).
 *
 * THE FAILURE THIS GUARDS AGAINST. The lane ticks 48 times a day. A message
 * every tick trains the founder to stop reading it — the same failure already
 * on record for the metered feed's old screening log, which ran flawlessly and
 * produced zero applications for weeks because nothing about it demanded a
 * reaction. So the alert must fire ONLY for a posting that is both a pass and
 * new, and an outage must never read as a quiet market.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IngestLine } from "../../../src/tools/jobhunt/ingest-batch.js";
import type { FreeIngestResult } from "../../../src/tools/jobhunt/free-ingest.js";

const mockRunFreeIngest = vi.fn<() => Promise<FreeIngestResult>>();
vi.mock("../../../src/tools/jobhunt/free-ingest.js", () => ({
  runFreeIngest: mockRunFreeIngest,
}));

const mockSendToChat = vi.fn(async () => {});
vi.mock("../../../src/infra/telegram-send.js", () => ({ sendToChat: mockSendToChat }));

const { runFreeSweep, FREE_SWEEP_CRON } = await import("../../../src/tools/jobhunt/sweep-runner.js");

function line(overrides: Partial<IngestLine> = {}): IngestLine {
  return {
    company: "Aquablu B.V.",
    title: "Embedded Software Engineer",
    outcome: "pass",
    detail: "",
    isNew: true,
    ...overrides,
  };
}

function result(overrides: Partial<FreeIngestResult> = {}): FreeIngestResult {
  return {
    seen: 10,
    screened: 5,
    lines: [],
    failures: [],
    notes: [],
    boardsPolled: 2,
    sweepId: "free-test",
    ...overrides,
  };
}

describe("runFreeSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends an alert when a new passing line exists", async () => {
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line()] }));
    await runFreeSweep();

    expect(mockSendToChat).toHaveBeenCalledOnce();
    const [text] = mockSendToChat.mock.calls[0]!;
    expect(text).toContain("Aquablu B.V.");
    expect(text).toContain("Embedded Software Engineer");
  });

  it("does not alert when every line is duplicate, reject, or flag", async () => {
    mockRunFreeIngest.mockResolvedValue(
      result({
        lines: [
          line({ outcome: "duplicate", isNew: false }),
          line({ outcome: "reject", isNew: true }),
          line({ outcome: "flag", isNew: true }),
        ],
      }),
    );
    await runFreeSweep();

    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("does not alert when the only passing line was already seen (isNew false)", async () => {
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line({ isNew: false })] }));
    await runFreeSweep();

    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("names at most 5 passing roles and states the true total when more exist", async () => {
    const lines = Array.from({ length: 8 }, (_, i) =>
      line({ company: `Company ${i}`, title: `Role ${i}` }),
    );
    mockRunFreeIngest.mockResolvedValue(result({ lines }));
    await runFreeSweep();

    const [text] = mockSendToChat.mock.calls[0]!;
    expect(text).toContain("8 new role");
    expect(text).toContain("Company 0");
    expect(text).toContain("Company 4");
    expect(text).not.toContain("Company 5");
    expect(text).toContain("+ 3 more");
  });

  it("does not invent /draft numbers, only points to the job brief", async () => {
    mockRunFreeIngest.mockResolvedValue(result({ lines: [line()] }));
    await runFreeSweep();

    const [text] = mockSendToChat.mock.calls[0]!;
    expect(text).not.toMatch(/\/draft \d/);
    expect(text.toLowerCase()).toContain("job brief");
  });

  it("fires the outage alert when every board failed and nothing was screened", async () => {
    mockRunFreeIngest.mockResolvedValue(
      result({
        screened: 0,
        failures: ["greenhouse/a: HTTP 500", "lever/b: HTTP 500", "ashby/c: HTTP 500", "greenhouse/d: HTTP 500"],
      }),
    );
    await runFreeSweep();

    expect(mockSendToChat).toHaveBeenCalledOnce();
    const [text] = mockSendToChat.mock.calls[0]!;
    expect(text).toContain("greenhouse/a");
    expect(text).toContain("lever/b");
    expect(text).toContain("ashby/c");
    expect(text).not.toContain("greenhouse/d"); // capped at 3 named boards
  });

  it("does not fire the outage alert when boards failed but some postings were still screened", async () => {
    mockRunFreeIngest.mockResolvedValue(
      result({ screened: 3, failures: ["greenhouse/a: HTTP 500"], lines: [line({ isNew: false })] }),
    );
    await runFreeSweep();

    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("does not reject when the underlying ingest throws", async () => {
    mockRunFreeIngest.mockRejectedValue(new Error("network down"));

    await expect(runFreeSweep()).resolves.toBeUndefined();
    expect(mockSendToChat).not.toHaveBeenCalled();
  });

  it("FREE_SWEEP_CRON is a valid 5-field cron expression firing every 30 minutes", () => {
    const fields = FREE_SWEEP_CRON.split(" ");
    expect(fields).toHaveLength(5);
    expect(fields[0]).toBe("*/30");
  });
});
