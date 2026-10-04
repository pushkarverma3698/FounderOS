/**
 * TDD — memory tools: searchMemoryTool + recordEventTool
 *
 * All DB queries are mocked — no live Postgres needed.
 * Run: pnpm test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CONTEXT_META_KEY, CONTEXT_STALE_MARKER } from "../../../src/db/context-meta.js";

// ── DB query mocks ────────────────────────────────────────────────────────────

const mockSearchEpisodicMemory = vi.fn(async (): Promise<any[]> => []);
const mockSearchKnowledgeEntries = vi.fn(async (): Promise<any[]> => []);
const mockFindTurns = vi.fn(async (_q: any): Promise<any> => ({ turns: [], total: 0 }));
const mockEarliestTurn = vi.fn(async (_t: string): Promise<Date | null> => null);
const mockGetFounderContext = vi.fn(async () => ({}));
const mockInsertEpisodicEvent = vi.fn(async () => "test-id-1");

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    searchEpisodicMemory: mockSearchEpisodicMemory,
    searchKnowledgeEntries: mockSearchKnowledgeEntries,
    getFounderContext: mockGetFounderContext,
    insertEpisodicEvent: mockInsertEpisodicEvent,
  };
});

vi.mock("../../../src/db/conversation-turns.js", () => ({
  findConversationTurns: mockFindTurns,
  earliestConversationTurn: mockEarliestTurn,
}));

const { searchMemoryTool, recordEventTool } = await import("../../../src/tools/memory.js");

// ── searchMemoryTool ──────────────────────────────────────────────────────────

describe("searchMemoryTool", () => {
  beforeEach(() => {
    mockSearchEpisodicMemory.mockClear();
    mockSearchKnowledgeEntries.mockClear();
    mockFindTurns.mockReset();
    mockEarliestTurn.mockReset();
    mockGetFounderContext.mockClear();
    mockSearchEpisodicMemory.mockResolvedValue([]);
    mockSearchKnowledgeEntries.mockResolvedValue([]);
    mockFindTurns.mockResolvedValue({ turns: [], total: 0 });
    mockEarliestTurn.mockResolvedValue(null);
    mockGetFounderContext.mockResolvedValue({});
  });

  // ── conversations tier ─────────────────────────────────────────────────────
  // `conversations` used to read the `conversations` table, which nothing writes to, so it could only ever
  // return stale rows. It now reads the turn log (conversation_turns), which every finished turn is saved to,
  // and only for the chat the call runs in: the thread id comes from the run's config, never from an argument.

  const THREAD = { configurable: { thread_id: "turicks:123" } };
  const TURN = {
    turn_id: "t1",
    occurred_at: new Date("2026-10-02T09:30:00Z"),
    user_input: "remind me to renew the visa paperwork before November",
    goal: "set a reminder",
    outcome: "done" as const,
    reply: "Done: I'll remind you on 28 October.",
  };

  it("type=conversations searches this chat's turn log and answers with the founder's own words", async () => {
    mockFindTurns.mockResolvedValue({ turns: [TURN], total: 1 });

    const result = await searchMemoryTool.invoke({ query: "visa paperwork", type: "conversations" }, THREAD);

    expect(mockFindTurns).toHaveBeenCalledWith(expect.objectContaining({ threadId: "turicks:123", terms: ["visa", "paperwork"] }));
    expect(result).toContain('You: "remind me to renew the visa paperwork before November"');
    expect(result).not.toContain("No memory found");
  });

  it("type=conversations skips episodic and knowledge", async () => {
    mockFindTurns.mockResolvedValue({ turns: [TURN], total: 1 });

    await searchMemoryTool.invoke({ query: "visa", type: "conversations" }, THREAD);

    expect(mockSearchEpisodicMemory).not.toHaveBeenCalled();
    expect(mockSearchKnowledgeEntries).not.toHaveBeenCalled();
  });

  it("type=conversations with nothing found says what was searched, not 'record an event'", async () => {
    mockEarliestTurn.mockResolvedValue(new Date("2026-10-04T08:00:00Z"));

    const result = await searchMemoryTool.invoke({ query: "visa", type: "conversations" }, THREAD);

    expect(result).toContain("I found nothing");
    expect(result).not.toContain("record_event");
  });

  it("type=all adds a Conversations section when this chat mentioned the topic", async () => {
    mockFindTurns.mockResolvedValue({ turns: [TURN], total: 1 });

    const result = await searchMemoryTool.invoke({ query: "visa" }, THREAD);

    expect(result).toContain("**Conversations:**");
    expect(result).toContain("visa paperwork");
  });

  it("type=all stays quiet about conversations when none match", async () => {
    const result = await searchMemoryTool.invoke({ query: "nonexistent" }, THREAD);

    expect(result).toContain("No memory found");
    expect(result).not.toContain("Conversations");
  });

  it("says how many more matched instead of hiding them", async () => {
    mockFindTurns.mockResolvedValue({ turns: [TURN], total: 9 });

    const result = await searchMemoryTool.invoke({ query: "visa" }, THREAD);

    expect(result).toContain("8 more");
  });

  it("without a thread id (the IDE MCP): type=all skips conversations, type=conversations refuses and says why", async () => {
    mockFindTurns.mockResolvedValue({ turns: [TURN], total: 1 });

    const all = await searchMemoryTool.invoke({ query: "visa" });
    const only = await searchMemoryTool.invoke({ query: "visa", type: "conversations" });

    expect(mockFindTurns).not.toHaveBeenCalled();
    expect(all).not.toContain("visa paperwork");
    expect(only).toContain("can't tell which chat");
  });

  it("takes no thread argument: the chat to read cannot be named by the caller", () => {
    const shape = (searchMemoryTool.schema as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape).sort()).toEqual(["query", "type"]);
  });

  it("reads another chat's log only if the run itself is in that chat", async () => {
    mockFindTurns.mockResolvedValue({ turns: [TURN], total: 1 });

    await searchMemoryTool.invoke({ query: "visa" }, { configurable: { thread_id: "turicks:group-9" } });

    expect(mockFindTurns).toHaveBeenCalledWith(expect.objectContaining({ threadId: "turicks:group-9" }));
  });

  it("returns a no-results message when all sources are empty", async () => {
    const result = await searchMemoryTool.invoke({ query: "nonexistent" });
    expect(result).toContain("No memory found");
  });

  it("returns episodic results when present", async () => {
    mockSearchEpisodicMemory.mockResolvedValue([
      {
        id: 1,
        title: "Discussed Stripe integration with Alex",
        summary: "Alex wants a Stripe webhook handler in TypeScript.",
        event_type: "conversation",
        occurred_at: new Date("2026-06-01T10:00:00Z"),
        tags: ["stripe", "typescript"],
        thread_id: "turicks:123",
        source: "telegram",
      },
    ]);
    const result = await searchMemoryTool.invoke({ query: "stripe" });
    expect(result).toContain("Discussed Stripe integration with Alex");
    expect(result).toContain("Alex wants a Stripe webhook");
  });

  it("returns knowledge entries when present", async () => {
    mockSearchKnowledgeEntries.mockResolvedValue([
      {
        title: "ADR-002: Use Composio",
        content: "We chose Composio because it handles OAuth.",
        entry_type: "adr",
        tags: ["composio"],
      },
    ]);
    const result = await searchMemoryTool.invoke({ query: "composio" });
    expect(result).toContain("ADR-002: Use Composio");
  });

  it("includes context data when present and query matches", async () => {
    mockGetFounderContext.mockResolvedValue({
      active_clients: ["Acme Corp", "Beta Ltd"],
      current_priorities: ["Close Acme deal"],
    });
    const result = await searchMemoryTool.invoke({ query: "acme" });
    expect(result).toContain("Acme Corp");
  });

  it("never surfaces internal bookkeeping keys from founder context", async () => {
    mockGetFounderContext.mockResolvedValue({
      active_clients: ["TestCo"],
      budget_alerts_sent: { date: "2026-09-28", levels: [80] },
    });
    // "budget" matches the bookkeeping key name; type=context with no match
    // would also dump every key — neither path may show it.
    for (const query of ["budget", "no-such-term"]) {
      const result = await searchMemoryTool.invoke({ query, type: "context" });
      expect(result).not.toContain("budget alerts sent");
      expect(result).not.toContain("[object Object]");
    }
  });

  // search_memory is the other tool the planner points at for "what is my focus?"
  // (planner rule: read_context, search_memory). It printed the same undated
  // values read_context did, so it dates them the same way.
  describe("founder context lines carry the date they were confirmed", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("dates a confirmed value, and flags one with no date, in type=context results", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-30T05:30:00.000Z"));
      mockGetFounderContext.mockResolvedValue({
        current_focus: "Close the Acme pilot",
        active_clients: ["Acme Corp"],
        [CONTEXT_META_KEY]: { current_focus: { at: "2026-09-29T19:00:00.000Z", source: "founder" } },
      });
      const result = String(await searchMemoryTool.invoke({ query: "no-such-term", type: "context" }));
      expect(result).toContain("• current focus: Close the Acme pilot (confirmed 2026-09-30)");
      expect(result).toContain(`• active clients: Acme Corp ${CONTEXT_STALE_MARKER} date unknown`);
    });

    it("dates the lines a query matches under type=all too, and never prints context_meta", async () => {
      mockGetFounderContext.mockResolvedValue({
        active_clients: ["Acme Corp"],
        [CONTEXT_META_KEY]: { active_clients: { at: "2026-06-01T00:00:00.000Z", source: "founder" } },
      });
      const result = String(await searchMemoryTool.invoke({ query: "acme" }));
      expect(result).toContain(`• active clients: Acme Corp ${CONTEXT_STALE_MARKER} last confirmed 2026-06-01`);
      expect(result).not.toContain("context meta");
      expect(result).not.toContain("[object Object]");
    });

    it("still answers when the meta is corrupt: every line reads date unknown", async () => {
      mockGetFounderContext.mockResolvedValue({ active_clients: ["Acme Corp"], [CONTEXT_META_KEY]: 42 });
      const result = String(await searchMemoryTool.invoke({ query: "acme", type: "context" }));
      expect(result).toContain(`Acme Corp ${CONTEXT_STALE_MARKER} date unknown`);
    });
  });

  it("filters by type=episodic — skips knowledge and context", async () => {
    mockSearchEpisodicMemory.mockResolvedValue([
      {
        id: 2,
        title: "Task completed: website launch",
        summary: "Launched turicks.com",
        event_type: "task_completed",
        occurred_at: new Date("2026-06-02T09:00:00Z"),
        tags: ["website"],
        thread_id: null,
        source: "manual",
      },
    ]);
    const result = await searchMemoryTool.invoke({ query: "website", type: "episodic" });
    expect(result).toContain("Task completed: website launch");
    expect(mockSearchKnowledgeEntries).not.toHaveBeenCalled();
  });

  it("filters by type=knowledge — skips episodic", async () => {
    mockSearchKnowledgeEntries.mockResolvedValue([
      {
        title: "Brand Voice Guide",
        content: "Never say excited to share.",
        entry_type: "brand",
        tags: ["brand"],
      },
    ]);
    const result = await searchMemoryTool.invoke({ query: "brand", type: "knowledge" });
    expect(result).toContain("Brand Voice Guide");
    expect(mockSearchEpisodicMemory).not.toHaveBeenCalled();
  });

  it("filters by type=context — skips episodic and knowledge", async () => {
    mockGetFounderContext.mockResolvedValue({ active_clients: ["TestCo"] });
    const result = await searchMemoryTool.invoke({ query: "clients", type: "context" });
    expect(result).toContain("TestCo");
    expect(mockSearchEpisodicMemory).not.toHaveBeenCalled();
    expect(mockSearchKnowledgeEntries).not.toHaveBeenCalled();
  });

  it("combines results from multiple sources when type=all", async () => {
    mockSearchEpisodicMemory.mockResolvedValue([
      {
        id: 3,
        title: "Met with Alex about LinkedIn",
        summary: "Discussed LinkedIn automation.",
        event_type: "conversation",
        occurred_at: new Date("2026-06-03T08:00:00Z"),
        tags: ["linkedin"],
        thread_id: "turicks:999",
        source: "telegram",
      },
    ]);
    mockSearchKnowledgeEntries.mockResolvedValue([
      {
        title: "LinkedIn Brand Pillar",
        content: "Hook on line 1, 150–300 words.",
        entry_type: "brand",
        tags: ["linkedin"],
      },
    ]);
    const result = await searchMemoryTool.invoke({ query: "linkedin", type: "all" });
    expect(result).toContain("Met with Alex about LinkedIn");
    expect(result).toContain("LinkedIn Brand Pillar");
  });
});

// ── recordEventTool ───────────────────────────────────────────────────────────

describe("recordEventTool", () => {
  beforeEach(() => {
    mockInsertEpisodicEvent.mockClear();
    mockInsertEpisodicEvent.mockResolvedValue("new-event-id");
  });

  it("inserts an episodic event and confirms with ID", async () => {
    const result = await recordEventTool.invoke({
      title: "Closed Acme deal",
      summary: "Signed a 3-month contract with Acme Corp for €12K.",
      tags: ["acme", "sales", "closed-won"],
      event_type: "outcome",
    });
    expect(mockInsertEpisodicEvent).toHaveBeenCalledOnce();
    expect(result).toContain("Closed Acme deal");
    expect(result).toContain("recorded");
  });

  it("passes the correct shape to insertEpisodicEvent", async () => {
    await recordEventTool.invoke({
      title: "Sprint planning done",
      summary: "Planned Phase D features.",
      tags: ["planning"],
      event_type: "decision",
      occurred_at: "2026-06-04T09:00:00Z",
    });
    const [call] = (mockInsertEpisodicEvent.mock.calls[0] ?? []) as [Record<string, unknown>?];
    expect(call).toMatchObject({
      title: "Sprint planning done",
      event_type: "decision",
      tenant_id: expect.any(String),
    });
    expect(Array.isArray(call?.["tags"])).toBe(true);
  });

  it("uses current timestamp when occurred_at is omitted", async () => {
    const before = new Date();
    await recordEventTool.invoke({
      title: "Quick standup",
      summary: "Checked pipeline.",
      tags: [],
      event_type: "conversation",
    });
    const after = new Date();
    const [call] = (mockInsertEpisodicEvent.mock.calls[0] ?? []) as [Record<string, unknown>?];
    const occurred = call?.["occurred_at"] as Date;
    expect(occurred.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(occurred.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
