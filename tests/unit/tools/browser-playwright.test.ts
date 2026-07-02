/**
 * Unit tests for the Playwright browser backend (primitive `browser` tool).
 * Playwright is mocked at the module boundary — no real Chromium is launched.
 *
 * Covers what the live path can't cheaply prove: action dispatch, singleton
 * browser/page reuse across calls, the 100k-char output cap, and the soft-fail
 * envelope shape ({ ok:false, error }) — the class of bug the pure AppleScript
 * builder tests never touched.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  let pageClosed = false;
  const mockGoto = vi.fn(async () => undefined);
  const mockEvaluate = vi.fn(async () => "");
  const mockSetHeaders = vi.fn(async () => undefined);
  const mockPageClose = vi.fn(async () => {
    pageClosed = true;
  });
  const mockBrowserClose = vi.fn(async () => undefined);

  const fakePage = {
    goto: mockGoto,
    evaluate: mockEvaluate,
    setExtraHTTPHeaders: mockSetHeaders,
    isClosed: () => pageClosed,
    close: mockPageClose,
  };
  const mockNewPage = vi.fn(async () => {
    pageClosed = false;
    return fakePage;
  });
  const fakeBrowser = { newPage: mockNewPage, close: mockBrowserClose };
  const mockLaunch = vi.fn(async () => fakeBrowser);

  return {
    mockGoto,
    mockEvaluate,
    mockSetHeaders,
    mockPageClose,
    mockBrowserClose,
    mockNewPage,
    mockLaunch,
    resetClosed: () => {
      pageClosed = false;
    },
  };
});

vi.mock("playwright", () => ({ chromium: { launch: h.mockLaunch } }));

const { playwrightBrowserAction, closeBrowser } = await import(
  "../../../src/tools/browser-playwright.js"
);

describe("playwrightBrowserAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.resetClosed();
    h.mockLaunch.mockResolvedValue({
      newPage: h.mockNewPage,
      close: h.mockBrowserClose,
    });
  });

  afterEach(async () => {
    // Reset the module-level singleton so each test starts from a cold browser.
    await closeBrowser();
  });

  it("open_url navigates to the requested url and reports success", async () => {
    const r = await playwrightBrowserAction("open_url", { url: "https://example.com" });
    expect(r).toEqual({ ok: true, stdout: "Opened https://example.com", stderr: "" });
    expect(h.mockGoto).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ waitUntil: "domcontentloaded" }),
    );
  });

  it("open_url falls back to about:blank when no url is given", async () => {
    const r = await playwrightBrowserAction("open_url", {});
    expect(r.ok).toBe(true);
    expect(h.mockGoto).toHaveBeenCalledWith("about:blank", expect.anything());
  });

  it("get_page_text returns the page innerText", async () => {
    h.mockEvaluate.mockResolvedValueOnce("Hello world");
    const r = await playwrightBrowserAction("get_page_text", {});
    expect(r).toEqual({ ok: true, stdout: "Hello world", stderr: "" });
  });

  it("get_page_text caps output at 100,000 chars", async () => {
    h.mockEvaluate.mockResolvedValueOnce("x".repeat(200_000));
    const r = await playwrightBrowserAction("get_page_text", {});
    expect(r.ok).toBe(true);
    expect((r as { stdout: string }).stdout.length).toBe(100_000);
  });

  it("run_js stringifies the evaluated result", async () => {
    h.mockEvaluate.mockResolvedValueOnce(42);
    const r = await playwrightBrowserAction("run_js", { js: "40 + 2" });
    expect(r).toEqual({ ok: true, stdout: "42", stderr: "" });
    expect(h.mockEvaluate).toHaveBeenCalledWith("40 + 2");
  });

  it("reuses a single browser + page across sequential actions (singleton)", async () => {
    await playwrightBrowserAction("open_url", { url: "https://a.com" });
    await playwrightBrowserAction("get_page_text", {});
    await playwrightBrowserAction("run_js", { js: "1" });
    // Launch + newPage each happen exactly once — the page is stateful across calls.
    expect(h.mockLaunch).toHaveBeenCalledTimes(1);
    expect(h.mockNewPage).toHaveBeenCalledTimes(1);
  });

  it("returns a soft-fail envelope (never throws) when navigation fails", async () => {
    h.mockGoto.mockRejectedValueOnce(new Error("net::ERR_NAME_NOT_RESOLVED"));
    const r = await playwrightBrowserAction("open_url", { url: "https://nope.invalid" });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toContain("Playwright browser action failed");
    expect((r as { error: string }).error).toContain("net::ERR_NAME_NOT_RESOLVED");
  });

  it("closeBrowser tears down the singleton and is safe to call when idle", async () => {
    await playwrightBrowserAction("open_url", { url: "https://a.com" });
    await closeBrowser();
    expect(h.mockBrowserClose).toHaveBeenCalledTimes(1);
    // Idle call is a no-op (does not throw, does not re-close).
    await expect(closeBrowser()).resolves.toBeUndefined();
    expect(h.mockBrowserClose).toHaveBeenCalledTimes(1);
  });
});
