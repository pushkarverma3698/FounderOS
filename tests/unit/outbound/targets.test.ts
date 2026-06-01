/**
 * Phase D — outbound target list unit tests
 *
 * Verifies the founder_context-backed target list:
 *  - empty state returns []
 *  - add dedupes case-insensitively and persists
 *  - add respects the MAX_TARGETS cap
 *  - remove is case-insensitive and only writes when something changed
 *  - clear writes an empty list
 *
 * DB queries are mocked — no live Postgres needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let store: Record<string, unknown> = {};
const mockGetFounderContext = vi.fn(async () => store);
const mockUpsertFounderContext = vi.fn(async (_tenant: string, updates: Record<string, unknown>) => {
  store = { ...store, ...updates };
});

vi.mock("../../../src/db/queries.js", async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>);
  return {
    ...actual,
    getFounderContext: mockGetFounderContext,
    upsertFounderContext: mockUpsertFounderContext,
  };
});

const {
  getOutboundTargets,
  addOutboundTargets,
  removeOutboundTarget,
  clearOutboundTargets,
  TARGETS_KEY,
  MAX_TARGETS,
} = await import("../../../src/outbound/targets.js");

const TENANT = "turicks";

describe("outbound targets", () => {
  beforeEach(() => {
    store = {};
    mockGetFounderContext.mockClear();
    mockUpsertFounderContext.mockClear();
  });

  it("returns [] when nothing is stored", async () => {
    expect(await getOutboundTargets(TENANT)).toEqual([]);
  });

  it("adds new companies and persists under the namespaced key", async () => {
    const { added, targets } = await addOutboundTargets(TENANT, ["Acme Corp", "Beta Ltd"]);
    expect(added).toEqual(["Acme Corp", "Beta Ltd"]);
    expect(targets).toEqual(["Acme Corp", "Beta Ltd"]);
    expect(mockUpsertFounderContext).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ [TARGETS_KEY]: ["Acme Corp", "Beta Ltd"] }),
    );
  });

  it("dedupes case-insensitively and does not write when nothing is new", async () => {
    store = { [TARGETS_KEY]: ["Acme Corp"] };
    const { added, targets } = await addOutboundTargets(TENANT, ["acme corp", "  ACME CORP "]);
    expect(added).toEqual([]);
    expect(targets).toEqual(["Acme Corp"]);
    expect(mockUpsertFounderContext).not.toHaveBeenCalled();
  });

  it("respects the MAX_TARGETS cap", async () => {
    store = { [TARGETS_KEY]: Array.from({ length: MAX_TARGETS }, (_, i) => `Co${i}`) };
    const { added, targets } = await addOutboundTargets(TENANT, ["Overflow Inc"]);
    expect(added).toEqual([]);
    expect(targets).toHaveLength(MAX_TARGETS);
  });

  it("removes a company case-insensitively", async () => {
    store = { [TARGETS_KEY]: ["Acme Corp", "Beta Ltd"] };
    const { removed, targets } = await removeOutboundTarget(TENANT, "acme corp");
    expect(removed).toBe(true);
    expect(targets).toEqual(["Beta Ltd"]);
    expect(mockUpsertFounderContext).toHaveBeenCalled();
  });

  it("remove is a no-op (no write) when the company is absent", async () => {
    store = { [TARGETS_KEY]: ["Acme Corp"] };
    const { removed } = await removeOutboundTarget(TENANT, "Nonexistent");
    expect(removed).toBe(false);
    expect(mockUpsertFounderContext).not.toHaveBeenCalled();
  });

  it("clear writes an empty list", async () => {
    store = { [TARGETS_KEY]: ["Acme Corp"] };
    await clearOutboundTargets(TENANT);
    expect(mockUpsertFounderContext).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ [TARGETS_KEY]: [] }),
    );
  });
});
