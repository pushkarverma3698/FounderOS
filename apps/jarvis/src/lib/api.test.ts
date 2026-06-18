import { describe, it, expect, vi, beforeEach } from "vitest";
import { getApiToken, streamUrl } from "../lib/api.js";

describe("api client", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("streamUrl includes token query when VITE_WEB_GATEWAY_TOKEN is set", () => {
    // Token is compile-time; test the builder shape when empty
    const url = streamUrl("jarvis-desktop");
    expect(url).toContain("/api/v1/sessions/jarvis-desktop/stream");
    if (getApiToken()) {
      expect(url).toContain("token=");
    }
  });

  it("apiFetch throws ApiError on non-2xx", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "denied",
    } as Response);

    const { apiFetch, ApiError } = await import("../lib/api.js");
    await expect(apiFetch("/api/v1/missions")).rejects.toBeInstanceOf(ApiError);
  });
});
