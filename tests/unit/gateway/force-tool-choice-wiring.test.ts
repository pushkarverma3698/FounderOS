/**
 * REGRESSION (H4) — office-run.ts threads `configurable.forced_tool` into the
 * office.invoke() call ONLY when FORCE_TOOL_CHOICE is enabled, and only for
 * text that resolveForcedTool() actually classifies. Default (flag unset) is
 * byte-identical to before this fix — no forced_tool key at all.
 *
 * FORCE_TOOL_CHOICE is read once at config.ts module load, so it must be set
 * BEFORE office-run.js is imported — this file is isolated (its own module
 * registry) so the override only affects this file's tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

process.env["FORCE_TOOL_CHOICE"] = "true";

const getOffice = vi.fn();
const clearThreadCheckpoints = vi.fn(async () => 1);

vi.mock("../../../src/infra/checkpointer.js", () => ({ clearThreadCheckpoints }));
vi.mock("../../../src/agents/office.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/agents/office.js")>();
  return { ...actual, getOffice };
});
vi.mock("../../../src/infra/halt.js", () => ({
  readHalt: vi.fn(async () => null),
  formatHaltNotice: vi.fn(() => ""),
}));
vi.mock("../../../src/infra/conversation-recorder.js", () => ({
  recordConversationEnd: vi.fn(async () => {}),
}));

const { runOfficeText } = await import("../../../src/gateway/office-run.js");

function fakeCtx() {
  return {
    chat: { id: 777 },
    from: { id: 777 },
    reply: vi.fn(async () => {}),
    replyWithChatAction: vi.fn(async () => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeMsg(type: string, content: unknown) {
  return { content, _getType: () => type };
}

function healthyOffice(reply: string) {
  return {
    invoke: vi.fn(async () => ({ messages: [makeMsg("ai", reply)] })),
    getState: vi.fn(async () => ({ next: [], tasks: [], values: { messages: [] } })),
    updateState: vi.fn(async () => {}),
  };
}

describe("office-run.ts — forced_tool wiring (H4, FORCE_TOOL_CHOICE=true)", () => {
  beforeEach(() => {
    clearThreadCheckpoints.mockClear();
    getOffice.mockReset();
  });

  it("threads forced_tool=github_write into invoke config for a classified GitHub-write request", async () => {
    // NOTE: shell/inbox-read/github-read requests hit their OWN deterministic
    // fast paths (shell-hitl-fast-path.ts, inbox-fast-path.ts,
    // github-read-fast-path.ts) that bypass office.invoke() entirely — those
    // cases don't need forced tool_choice because the model never gets a
    // choice at all. github_write (and linkedin_post-with-provided-text) have
    // no such fast path, so they're the cases where this wiring is actually
    // exercised in the normal office loop.
    // Reply text deliberately avoids "created/opened/filed/issue #" so the
    // unbacked-github-write-claim execution guard doesn't fire a SECOND
    // invoke — this test is about the FIRST call's config, not the guard.
    const office = healthyOffice("Approval card sent — waiting on you.");
    getOffice.mockResolvedValue(office);

    await runOfficeText(fakeCtx(), "create a github issue in pushkarverma3698/FounderOS about the bug");

    const [, invokeConfig] = office.invoke.mock.calls[0]!;
    expect(invokeConfig.configurable.forced_tool).toBe("github_write");
  });

  it("does NOT set forced_tool for text with no high-confidence classification", async () => {
    const office = healthyOffice("here's the news");
    getOffice.mockResolvedValue(office);

    await runOfficeText(fakeCtx(), "what's the latest AI news?");

    const [, invokeConfig] = office.invoke.mock.calls[0]!;
    expect(invokeConfig.configurable.forced_tool).toBeUndefined();
  });
});
