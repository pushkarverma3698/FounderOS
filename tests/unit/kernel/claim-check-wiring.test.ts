/** AG-034 wiring: the synthesizer applies the progress guard and logs one claim.check line per turn. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";

const info = vi.hoisted(() => vi.fn());
vi.mock("../../../src/infra/logger.js", () => {
  const l: Record<string, unknown> = { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  l.child = () => l;
  return { logger: l, childLogger: () => l };
});
vi.mock("../../../src/db/queries.js", () => ({ writeTaskOutcome: async () => undefined }));

import { makeSynthesizeNode } from "../../../src/kernel/synthesizer.js";
import { NO_STATUS_NOTICE } from "../../../src/kernel/progress-guard.js";
import type { KernelStateType } from "../../../src/kernel/state.js";

const model = (content: string) => ({ invoke: async (_m: BaseMessage[]) => new AIMessage({ content }) });

beforeEach(() => info.mockClear());

describe("claim check in the synthesizer", () => {
  it("#396 reply is replaced and one claim.check line carries the counts", async () => {
    const synthesize = makeSynthesizeNode(
      model("Antigravity is actively executing in its isolated workspace. About 95% of tasks finish."),
    );
    const state = {
      turn: { id: "t396", chat_id: "1", received_at: new Date().toISOString(), raw_input: "why no branch?" },
      mission: { goal: "why no branch", status: "synthesizing", plan: null, cursor: 1 },
      results: [],
    } as unknown as KernelStateType;
    const update = await synthesize(state);
    expect(update.reply).toContain(NO_STATUS_NOTICE);
    expect(update.reply).not.toContain("actively executing");
    const lines = info.mock.calls.filter((c) => (c[0] as { seam?: string }).seam === "claim.check");
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toMatchObject({ seam: "claim.check", turnId: "t396", promise: 0, progress: 1, number: 1 });
  });
});
