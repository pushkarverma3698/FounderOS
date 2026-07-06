/**
 * REGRESSION (M2) — a provider 503/quota error on the SUPERVISOR's own LLM
 * call now retries once against a fallback-model-bound office before giving
 * up, instead of the turn simply failing outright.
 *
 * createSupervisor takes a bare model with no middleware option, so the
 * department-level fallback middleware (used everywhere else) cannot cover
 * it — getFallbackOffice() (office.ts) compiles a SEPARATE office for this
 * one purpose. This test mocks BOTH getOffice and getFallbackOffice to
 * simulate the primary office throwing a 503-shaped error and the fallback
 * office completing the turn normally.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getOffice = vi.fn();
const getFallbackOffice = vi.fn();
const clearThreadCheckpoints = vi.fn(async () => 1);

vi.mock("../../../src/infra/checkpointer.js", () => ({ clearThreadCheckpoints }));
vi.mock("../../../src/agents/office.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/agents/office.js")>();
  return { ...actual, getOffice, getFallbackOffice };
});
vi.mock("../../../src/infra/halt.js", () => ({
  readHalt: vi.fn(async () => null),
  formatHaltNotice: vi.fn(() => ""),
}));
vi.mock("../../../src/infra/conversation-recorder.js", () => ({
  recordConversationEnd: vi.fn(async () => {}),
}));

const { runOfficeText } = await import("../../../src/gateway/office-run.js");

interface Reply {
  text: string;
}

function fakeCtx(replies: Reply[]) {
  return {
    chat: { id: 555 },
    from: { id: 555 },
    reply: vi.fn(async (text: string) => {
      replies.push({ text });
    }),
    replyWithChatAction: vi.fn(async () => {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeMsg(type: string, content: unknown) {
  return { content, _getType: () => type };
}

/** Primary office whose supervisor call always 503s. */
function outageOffice() {
  return {
    invoke: vi.fn().mockRejectedValue(new Error("503 Service Unavailable — model overloaded")),
    getState: vi.fn(async () => ({ next: [], tasks: [], values: { messages: [] } })),
    updateState: vi.fn(async () => {}),
  };
}

/** Fallback office that completes the turn normally. */
function workingFallbackOffice(reply: string) {
  return {
    invoke: vi.fn(async () => ({ messages: [makeMsg("ai", reply)] })),
    getState: vi.fn(async () => ({ next: [], tasks: [], values: { messages: [] } })),
    updateState: vi.fn(async () => {}),
  };
}

describe("runOfficeText — supervisor-level provider outage retries the fallback office (M2)", () => {
  beforeEach(() => {
    clearThreadCheckpoints.mockClear();
    getOffice.mockReset();
    getFallbackOffice.mockReset();
  });

  it("retries against the fallback office and delivers ITS reply when configured", async () => {
    getOffice.mockResolvedValue(outageOffice());
    getFallbackOffice.mockResolvedValue(workingFallbackOffice("Here is the answer from the fallback model."));
    const replies: Reply[] = [];

    await runOfficeText(fakeCtx(replies), "what's my current focus?");

    const allText = replies.map((r) => r.text).join("\n---\n");
    expect(allText).toMatch(/fallback model/i);
    expect(allText).toMatch(/Here is the answer from the fallback model\./);
  });

  it("falls through to the standard outage notice when no fallback office is available", async () => {
    getOffice.mockResolvedValue(outageOffice());
    getFallbackOffice.mockResolvedValue(null);
    const replies: Reply[] = [];

    await runOfficeText(fakeCtx(replies), "what's my current focus?");

    const allText = replies.map((r) => r.text).join("\n---\n");
    expect(allText).toMatch(/overloaded or unavailable/i);
    expect(allText).not.toMatch(/fallback model/i);
  });

  it("falls through to the standard notice when the fallback office ALSO fails", async () => {
    getOffice.mockResolvedValue(outageOffice());
    getFallbackOffice.mockResolvedValue(outageOffice());
    const replies: Reply[] = [];

    await runOfficeText(fakeCtx(replies), "what's my current focus?");

    const allText = replies.map((r) => r.text).join("\n---\n");
    expect(allText).toMatch(/overloaded or unavailable/i);
  });

  it("getFallbackOffice() throwing is handled gracefully (never crashes the turn)", async () => {
    getOffice.mockResolvedValue(outageOffice());
    getFallbackOffice.mockRejectedValue(new Error("checkpointer unavailable"));
    const replies: Reply[] = [];

    await runOfficeText(fakeCtx(replies), "what's my current focus?");

    const allText = replies.map((r) => r.text).join("\n---\n");
    expect(allText).toMatch(/overloaded or unavailable/i);
  });
});
