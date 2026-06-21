import { describe, it, expect } from "vitest";
import { createWebApp } from "../../../src/gateway/web.js";

describe("web gateway CORS", () => {
  it("allows localhost preflight for JARVIS UI", async () => {
    const app = createWebApp();
    const res = await app.fetch(
      new Request("http://127.0.0.1:3001/api/v1/health", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:3000" },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
  });
});
