/**
 * Unit tests for the ops cockpit (Phase 5) — pure assembly + read-only endpoints.
 */

import { describe, it, expect, vi } from "vitest";
import {
  DEPARTMENT_KEYS,
  buildCockpitState,
  listMcpServers,
  subgraphState,
  summarizeCost,
  type CostRow,
} from "../../../src/gateway/cockpit.js";

describe("cockpit topology", () => {
  it("exposes the seven locked departments in a stable order", () => {
    expect(buildCockpitState().departments).toEqual([
      "research",
      "comms",
      "engineering",
      "marketing",
      "sales",
      "personal",
      "jobhunt",
    ]);
    expect(DEPARTMENT_KEYS).toHaveLength(7);
  });

  it("reflects the live subgraph config flags", () => {
    const sg = subgraphState();
    expect(typeof sg.engineering).toBe("boolean");
    expect(typeof sg.revenue).toBe("boolean");
    expect(buildCockpitState().subgraphs).toEqual(sg);
  });

  it("reads bridged MCP servers from the real manifest", () => {
    const servers = listMcpServers(); // default mcp-bridge.json
    expect(Array.isArray(servers)).toBe(true);
    for (const s of servers) {
      expect(typeof s.name).toBe("string");
      expect(Array.isArray(s.departments)).toBe(true);
      expect(typeof s.writeTools).toBe("number");
    }
  });

  it("never throws on a missing manifest — returns an empty list", () => {
    expect(listMcpServers("/no/such/manifest-xyz.json")).toEqual([]);
  });

  it("stamps an ISO generatedAt", () => {
    expect(buildCockpitState().generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("summarizeCost", () => {
  it("rolls token + USD totals across rows", () => {
    const rows: CostRow[] = [
      { model: "g", agent: "research", calls: 2, total_tokens_in: 100, total_tokens_out: 50, total_cost_usd: "0.01" },
      { model: "g", agent: "sales", calls: 3, total_tokens_in: 200, total_tokens_out: 80, total_cost_usd: "0.02" },
    ];
    const { totals } = summarizeCost(rows);
    expect(totals).toEqual({ calls: 5, tokensIn: 300, tokensOut: 130, costUsd: 0.03 });
  });

  it("handles an empty window without NaN", () => {
    expect(summarizeCost([]).totals).toEqual({ calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 });
  });
});

describe("cockpit endpoints", () => {
  it("GET /api/v1/cockpit/state returns topology", async () => {
    const { createWebApp } = await import("../../../src/gateway/web.js");
    const res = await createWebApp().request("http://localhost/api/v1/cockpit/state");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.departments).toContain("engineering");
    expect(body.subgraphs).toBeDefined();
  });

  it("GET /api/v1/cockpit/cost clamps days and summarizes", async () => {
    vi.resetModules();
    vi.doMock("../../../src/db/queries.js", async (orig) => ({
      ...(await orig<typeof import("../../../src/db/queries.js")>()),
      getCostBreakdown: vi.fn().mockResolvedValue([
        { model: "g", agent: "x", calls: 1, total_tokens_in: 10, total_tokens_out: 5, total_cost_usd: "0.5" },
      ]),
    }));
    const { createWebApp } = await import("../../../src/gateway/web.js");
    const res = await createWebApp().request("http://localhost/api/v1/cockpit/cost?days=999");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.days).toBe(90); // clamped
    expect(body.totals.costUsd).toBe(0.5);
    vi.doUnmock("../../../src/db/queries.js");
    vi.resetModules();
  });

  it("GET /api/v1/cockpit/knowledge returns empty for a blank query", async () => {
    const { createWebApp } = await import("../../../src/gateway/web.js");
    const res = await createWebApp().request("http://localhost/api/v1/cockpit/knowledge");
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([]);
  });
});
