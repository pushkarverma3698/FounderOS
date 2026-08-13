/**
 * TDD — memory tools: searchMemoryTool + recordEventTool
 *
 * All DB queries are mocked — no live Postgres needed.
 * Run: pnpm test
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── DB query mocks ────────────────────────────────────────────────────────────

const mockSearchEpisodicMemory = vi.fn(async (): Promise<any[]> => []);
const mockSearchKnowledgeEntries = vi.fn(async (): Promise<any[]> => []);
const mockSearchConversations = vi.fn(async (): Promise<any[]> => []);
const mockGetFounderContext = vi.fn(async () => ({}));
const mockInsertEpisodicEvent = vi.fn(async () => "test-id-1");

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    searchEpisodicMemory: mockSearchEpisodicMemory,
    searchKnowledgeEntries: mockSearchKnowledgeEntries,
    searchConversations: mockSearchConversations,
    getFounderContext: mockGetFounderContext,
    insertEpisodicEvent: mockInsertEpisodicEvent,
  };
});

const { searchMemoryTool, recordEventTool } = await import("../../../src/tools/memory.js");

// ── searchMemoryTool ──────────────────────────────────────────────────────────

describe("searchMemoryTool", () => {
  beforeEach(() => {
    mockSearchEpisodicMemory.mockClear();
    mockSearchKnowledgeEntries.mockClear();
    mockSearchConversations.mockClear();
    mockGetFounderContext.mockClear();
    mockSearchEpisodicMemory.mockResolvedValue([]);
    mockSearchKnowledgeEntries.mockResolvedValue([]);
    mockSearchConversations.mockResolvedValue([]);
    mockGetFounderContext.mockResolvedValue({});
  });

  // ── conversations tier ─────────────────────────────────────────────────────
  // The enum advertised `conversations` in both the Zod schema and the MCP
  // inputSchema, and no branch implemented it. Nine rows sat in
  // agents.conversations and every one of them was unreachable — a live call
  // with type:"conversations" answered "No memory found" for a query that
  // matched a stored summary verbatim.

  const CONVERSATION_ROW = {
    thread_id: "turicks:jarvis-cinematic",
    summary: "I'm FounderOS — Pushkar's AI chief of staff, built on Turicks infrastructure.",
    topics: ["founderos", "identity"],
    message_count: 5,
    last_message_at: new Date("2026-06-22T12:00:00Z"),
  };

  it("returns conversation history when type=conversations", async () => {
    mockSearchConversations.mockResolvedValue([CONVERSATION_ROW]);

    const result = await searchMemoryTool.invoke({ query: "founderos", type: "conversations" });

    expect(result).not.toContain("No memory found");
    expect(result).toContain("chief of staff");
    expect(result).toContain("turicks:jarvis-cinematic");
  });

  it("searches conversations under type=all", async () => {
    mockSearchConversations.mockResolvedValue([CONVERSATION_ROW]);

    const result = await searchMemoryTool.invoke({ query: "founderos" });

    expect(mockSearchConversations).toHaveBeenCalled();
    expect(result).toContain("chief of staff");
  });

  it("filters by type=conversations — skips episodic and knowledge", async () => {
    mockSearchConversations.mockResolvedValue([CONVERSATION_ROW]);

    await searchMemoryTool.invoke({ query: "founderos", type: "conversations" });

    expect(mockSearchEpisodicMemory).not.toHaveBeenCalled();
    expect(mockSearchKnowledgeEntries).not.toHaveBeenCalled();
  });

  it("shows the message count so an empty thread is distinguishable from a full one", async () => {
    mockSearchConversations.mockResolvedValue([CONVERSATION_ROW]);

    const result = await searchMemoryTool.invoke({ query: "founderos", type: "conversations" });

    expect(result).toContain("5 message");
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
