/**
 * Unit tests for src/tools/browser-playwright.ts
 * Mocks the underlying playwright chromium instance.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPage = {
  isClosed: vi.fn().mockReturnValue(false),
  setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
  goto: vi.fn().mockResolvedValue(undefined),
  evaluate: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
};

const mockBrowser = {
  newPage: vi.fn().mockResolvedValue(mockPage),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn().mockImplementation(() => Promise.resolve(mockBrowser)),
  },
}));

import { playwrightBrowserAction, closeBrowser } from "../../../src/tools/browser-playwright.js";

describe("playwrightBrowserAction", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await closeBrowser();
  });

  it("handles open_url action", async () => {
    const res = await playwrightBrowserAction("open_url", { url: "https://example.com" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.stdout).toContain("Opened https://example.com");
    }
    expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", expect.objectContaining({ waitUntil: "domcontentloaded" }));
  });

  it("handles get_page_text action", async () => {
    mockPage.evaluate.mockResolvedValueOnce("Hello World Page Content");
    const res = await playwrightBrowserAction("get_page_text", {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.stdout).toBe("Hello World Page Content");
    }
  });

  it("handles run_js action", async () => {
    mockPage.evaluate.mockResolvedValueOnce("Custom JS Result");
    const res = await playwrightBrowserAction("run_js", { js: "document.title" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.stdout).toBe("Custom JS Result");
    }
    expect(mockPage.evaluate).toHaveBeenCalledWith("document.title");
  });

  it("catches errors fail-safe", async () => {
    mockPage.goto.mockRejectedValueOnce(new Error("Network timeout"));
    const res = await playwrightBrowserAction("open_url", { url: "https://invalid.url" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("Playwright browser action failed: Network timeout");
    }
  });

  it("closes browser session properly", async () => {
    await playwrightBrowserAction("open_url", { url: "https://example.com" });
    await closeBrowser();
    expect(mockPage.close).toHaveBeenCalled();
    expect(mockBrowser.close).toHaveBeenCalled();
  });
});
