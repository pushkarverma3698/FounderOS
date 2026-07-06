/**
 * REGRESSION (H4) — FORCE_TOOL_CHOICE defaults OFF: even text that would
 * classify to a forced tool must NOT get configurable.forced_tool set unless
 * the flag is explicitly enabled. Byte-identical behaviour to before this fix.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

delete process.env["FORCE_TOOL_CHOICE"];

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
    chat: { id: 888 },
    from: { id: 888 },
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

describe("office-run.ts — forced_tool wiring is OFF by default (H4)", () => {
  beforeEach(() => {
    clearThreadCheckpoints.mockClear();
    getOffice.mockReset();
  });

  it("never sets configurable.forced_tool even for text that WOULD classify with the flag on", async () => {
    const office = healthyOffice("Approval card sent — waiting on you.");
    getOffice.mockResolvedValue(office);

    await runOfficeText(fakeCtx(), "create a github issue in pushkarverma3698/FounderOS about the bug");

    const [, invokeConfig] = office.invoke.mock.calls[0]!;
    expect(invokeConfig.configurable.forced_tool).toBeUndefined();
    expect("forced_tool" in invokeConfig.configurable).toBe(false);
  });
});
