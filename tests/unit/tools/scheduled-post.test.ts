/**
 * Unit tests for scheduleSocialPostTool — validation + persistence (DB mocked).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInsert = vi.fn();

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return { ...actual, insertScheduledPost: mockInsert };
});

const { scheduleSocialPostTool } = await import("../../../src/tools/scheduled-post.js");

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

describe("scheduleSocialPostTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockResolvedValue({ id: "sp1", status: "scheduled" });
  });

  it("persists a future post, resolving the marketing account + mention", async () => {
    const res = await scheduleSocialPostTool.execute({
      text: "Shipped v3 today",
      scheduled_at: FUTURE,
      tenant_id: "turicks",
      department: "marketing",
      idempotency_key: "k1",
      mention_urn: "urn:li:organization:99",
      mention_name: "Turicks",
    });

    expect(res.success).toBe(true);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "linkedin",
        account_key: "turicks", // DEPARTMENT_ACCOUNT_DEFAULTS.marketing.linkedin
        text: "Shipped v3 today",
        mention_urn: "urn:li:organization:99",
        mention_name: "Turicks",
        idempotency_key: "k1",
      }),
    );
    expect((res.data as { tagged: boolean }).tagged).toBe(true);
  });

  it("rejects a scheduled_at in the past and does not persist", async () => {
    const res = await scheduleSocialPostTool.execute({
      text: "hi",
      scheduled_at: "2020-01-01T00:00:00Z",
      tenant_id: "turicks",
      idempotency_key: "k2",
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/future/);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("rejects an unparseable datetime", async () => {
    const res = await scheduleSocialPostTool.execute({
      text: "hi",
      scheduled_at: "not-a-date",
      tenant_id: "turicks",
      idempotency_key: "k3",
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/valid ISO/);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("persists without a mention when none is provided (tagged=false)", async () => {
    const res = await scheduleSocialPostTool.execute({
      text: "no tag",
      scheduled_at: FUTURE,
      tenant_id: "turicks",
      department: "marketing",
      idempotency_key: "k4",
    });
    expect(res.success).toBe(true);
    expect((res.data as { tagged: boolean }).tagged).toBe(false);
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ mention_urn: null, mention_name: null }),
    );
  });
});
