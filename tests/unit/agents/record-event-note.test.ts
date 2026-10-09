/**
 * Live QA 2026-10-09 09:51: "save a note: GST filing for Turicks due 20 Oct" raised an approval card and was filed as
 * type task_completed. A note is a low-risk write the founder just asked for: no card, and its own type.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const hitl = vi.hoisted(() => vi.fn(async (_req: unknown) => null as string | null));
const insert = vi.hoisted(() => vi.fn(async (_row: unknown) => "evt-1"));

vi.mock("../../../src/agents/agent-tools/hitl.js", () => ({ hitlGate: hitl, idemKey: (...p: string[]) => p.join("|") }));
vi.mock("../../../src/db/queries.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  insertEpisodicEvent: insert,
}));

import { recordEvent } from "../../../src/agents/agent-tools/memory.js";
import { HITL_GATED_TOOLS } from "../../../src/infra/hitl.js";

beforeEach(() => {
  hitl.mockClear();
  insert.mockClear();
});

describe("record_event for a saved note", () => {
  it("writes straight away with no approval card, filed as a note", async () => {
    const res = String(
      await recordEvent.invoke({
        title: "GST filing deadline",
        summary: "GST filing for Turicks is due 20 Oct; the CA is handling it.",
        tags: ["GST"],
        event_type: "note",
      }),
    );
    expect(hitl).not.toHaveBeenCalled();
    expect(insert).toHaveBeenCalledTimes(1);
    expect((insert.mock.calls[0]![0] as { event_type: string }).event_type).toBe("note");
    expect(res).toContain("Event recorded");
  });

  it("is not on the approval list", () => {
    expect(HITL_GATED_TOOLS.has("record_event")).toBe(false);
  });
});
