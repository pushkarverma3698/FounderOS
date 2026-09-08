/**
 * Unit tests — the sentence and the slash command reach the same rows.
 *
 * THE FAILURE THIS GUARDS AGAINST, measured 2026-09-09. `jobBriefTool` declared
 * `verb`, `range` and `axis`; the LangChain wrapper the planner actually sees
 * (capabilities.ts registers `jobBrief`, never `jobBriefTool`) declared only
 * `skip_liveness` and `profile`. So "tashi's last 2 days jobs found" arrived as
 * `{profile: "tashi"}` — the window and the axis were dropped in the wrapper,
 * silently, and the founder got the default brief with nothing saying half his
 * sentence had been discarded.
 *
 * A dropped filter is worse than a rejected one: it answers a question nobody
 * asked and looks like an answer to the one they did.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const execute = vi.fn();

vi.mock("../../../src/tools/jobhunt/daily-brief.js", () => ({
  jobBriefTool: {
    name: "job_brief",
    description: "the ranked job brief",
    execute: (...args: unknown[]) => execute(...args),
  },
}));

const { jobBrief } = await import("../../../src/agents/agent-tools/jobhunt.js");
const { exportJobsCsv } = await import("../../../src/agents/agent-tools/state.js");

beforeEach(() => {
  execute.mockReset();
  execute.mockResolvedValue({ success: true, data: "brief text" });
});

describe("job_brief — the schema the planner sees", () => {
  it("accepts the three fields the slash commands parse", () => {
    // If these are absent from the wrapper's schema the planner cannot send
    // them, whatever the underlying tool declares.
    const keys = Object.keys((jobBrief.schema as { shape: Record<string, unknown> }).shape);
    expect(keys).toContain("verb");
    expect(keys).toContain("range");
    expect(keys).toContain("axis");
  });

  it("forwards a window and an axis instead of dropping them", async () => {
    // "tashi's last 2 days jobs found"
    await jobBrief.invoke({ profile: "wife-nl-finance", verb: "jobs", range: "2 days", axis: "found" });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "wife-nl-finance", verb: "jobs", range: "2 days", axis: "found" }),
    );
  });

  it("forwards the fresh verb", async () => {
    await jobBrief.invoke({ verb: "fresh" });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ verb: "fresh" }));
  });

  it("sends nothing extra when the founder named no window", async () => {
    // An omitted field must leave the verb's own default in force rather than
    // arriving as an explicit null the resolver has to interpret.
    await jobBrief.invoke({ profile: "wife" });
    const args = execute.mock.calls[0]![0] as Record<string, unknown>;
    expect(args).not.toHaveProperty("verb");
    expect(args).not.toHaveProperty("range");
    expect(args).not.toHaveProperty("axis");
  });

  it("refuses an unresolvable candidate rather than guessing between two queues", async () => {
    const reply = await jobBrief.invoke({ profile: "nobody" });
    expect(reply).toContain("Unknown profile");
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("export_jobs_csv — the schema the planner sees", () => {
  it("takes the same verb/range/axis, so a CSV needs no date arithmetic", () => {
    const keys = Object.keys((exportJobsCsv.schema as { shape: Record<string, unknown> }).shape);
    expect(keys).toContain("verb");
    expect(keys).toContain("range");
    expect(keys).toContain("axis");
  });

  it("exposes a way to skip the link check, so speed is a choice not a default", () => {
    const keys = Object.keys((exportJobsCsv.schema as { shape: Record<string, unknown> }).shape);
    expect(keys).toContain("skip_liveness");
  });
});
