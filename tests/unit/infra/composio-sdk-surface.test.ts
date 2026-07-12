/**
 * Mock-drift guard — the REAL @composio/core surface the probes depend on.
 * ==========================================================================
 * 2026-07-12 prod outage class: provider probes called
 * composio.getClient().connectedAccounts.get(), which does not exist in the
 * installed SDK — but provider-probes.test.ts mocked that exact wrong shape,
 * so CI stayed green while /health reported the probe crash. This file imports
 * the real SDK (NO vi.mock) and pins the surface the probes actually use.
 * Construction only — telemetry off, no network.
 */

import { describe, it, expect } from "vitest";
import { Composio } from "@composio/core";

describe("@composio/core installed surface (probe call path)", () => {
  it("exposes connectedAccounts.get on the Composio instance", () => {
    const composio = new Composio({ apiKey: "ck_test_offline_only", allowTracking: false });
    expect(typeof composio.connectedAccounts).toBe("object");
    expect(typeof composio.connectedAccounts.get).toBe("function");
  });
});
