/**
 * Unit tests — the `job_state` LangChain wrapper (src/agents/agent-tools/state.ts).
 *
 * THE GAP THIS PINS. On 2026-09-07 `job_state` gained a `profile` filter and
 * its description was rewritten to instruct the worker to "pass
 * `profile: '<their id>'` … Never answer for a named candidate using data you
 * did not explicitly filter to their profile." The UnifiedTool honoured it. The
 * wrapper the worker actually calls did not: its Zod schema had no `profile`
 * field, so the argument was not merely ignored — it was unrepresentable. A
 * model following the instruction to the letter could not comply, and every
 * question about the second candidate ran against the founder's own queue while
 * the prompt asserted otherwise. The same wrapper also dropped `track`, the one
 * filter that answers a question phrased off `job_brief`'s own output.
 *
 * A tool argument that exists in the description and not in the schema is worse
 * than a missing filter: it reads as correct at every layer that documents it.
 */

import { describe, it, expect, vi } from "vitest";

const mockExecute = vi.fn(async () => ({ success: true as const, data: '{"count":0,"total":0,"rows":[]}' }));
vi.mock("../../../src/tools/job-state.js", () => ({
  jobStateTool: { name: "job_state", description: "mock job_state", execute: mockExecute },
}));

const { jobState } = await import("../../../src/agents/agent-tools/state.js");

describe("job_state wrapper — the schema must be able to express what the prompt demands", () => {
  it("forwards profile to the underlying tool", async () => {
    mockExecute.mockClear();
    await jobState.invoke({ profile: "wife-nl-finance" });
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({ profile: "wife-nl-finance" }));
  });

  it("forwards track to the underlying tool", async () => {
    mockExecute.mockClear();
    await jobState.invoke({ track: "accountant" });
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({ track: "accountant" }));
  });

  it("omits profile entirely when not given — never sends an empty string that resolves to nothing", async () => {
    mockExecute.mockClear();
    await jobState.invoke({ limit: 5 });
    expect(mockExecute).toHaveBeenCalledWith(expect.not.objectContaining({ profile: expect.anything() }));
  });

  it("still forwards the filters it always had", async () => {
    mockExecute.mockClear();
    await jobState.invoke({ stage: "screened", section: "do_today", applied: false, limit: 20 });
    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "screened", section: "do_today", applied: false, limit: 20 }),
    );
  });

  it("surfaces the tool's refusal verbatim rather than reporting an empty result", async () => {
    mockExecute.mockClear();
    mockExecute.mockResolvedValueOnce({ success: false, error: 'Unknown track "astronaut".' } as never);
    const out = await jobState.invoke({ track: "astronaut" });
    expect(String(out)).toContain("astronaut");
  });
});
