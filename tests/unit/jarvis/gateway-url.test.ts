import { describe, it, expect } from "vitest";
import { apiUrl, gatewayBase } from "../../../apps/jarvis-next/lib/gateway-url.js";

describe("jarvis gateway-url", () => {
  it("builds /api/v1 paths against gateway host", () => {
    expect(apiUrl("/api/v1/missions")).toBe(`${gatewayBase()}/api/v1/missions`);
    expect(apiUrl("/api/v1/sessions/jarvis-cinematic/stream")).toContain("/api/v1/sessions/");
  });

  it("strips accidental /api suffix from gateway base", () => {
    const prev = process.env["JARVIS_GATEWAY_URL"];
    process.env["JARVIS_GATEWAY_URL"] = "http://127.0.0.1:3001/api";
    expect(apiUrl("/api/v1/health")).toBe("http://127.0.0.1:3001/api/v1/health");
    if (prev === undefined) delete process.env["JARVIS_GATEWAY_URL"];
    else process.env["JARVIS_GATEWAY_URL"] = prev;
  });
});
