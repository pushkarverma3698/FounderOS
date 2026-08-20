/**
 * Unit tests — provider config (pure env reads)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("provider-config", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    delete process.env["GMAIL_BACKEND"];
    delete process.env["CALENDAR_BACKEND"];
    delete process.env["LINKEDIN_BACKEND"];
    delete process.env["PROVIDER_SMOKE_AT_BOOT"];
    delete process.env["NODE_ENV"];
    // envOr() falls back to reading the real .env FILE off disk when
    // process.env is unset (a deliberate PROD_DOTENV-parity fallback, see
    // readKeyFromEnvFile in provider-config.ts) — so deleting process.env
    // above is not enough to simulate "unset" on its own. Without this mock
    // every "defaults to X" test below actually asserts on this developer's
    // local .env contents, not on the function's real default.
    vi.doMock("node:fs", () => ({
      readFileSync: () => {
        throw new Error("no .env — test isolation");
      },
    }));
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("defaults Gmail backend to gws", async () => {
    vi.resetModules();
    const { getGmailBackend } = await import("../../../src/infra/provider-config.js");
    expect(getGmailBackend()).toBe("gws");
  });

  it("honours GMAIL_BACKEND=composio for rollback", async () => {
    process.env["GMAIL_BACKEND"] = "composio";
    vi.resetModules();
    const { getGmailBackend } = await import("../../../src/infra/provider-config.js");
    expect(getGmailBackend()).toBe("composio");
  });

  it("defaults Calendar backend to gws", async () => {
    vi.resetModules();
    const { getCalendarBackend } = await import("../../../src/infra/provider-config.js");
    expect(getCalendarBackend()).toBe("gws");
  });

  it("defaults LinkedIn backend to direct", async () => {
    vi.resetModules();
    const { getLinkedInBackend } = await import("../../../src/infra/provider-config.js");
    expect(getLinkedInBackend()).toBe("direct");
  });

  it("shouldRunProviderSmoke is true in production by default", async () => {
    process.env["NODE_ENV"] = "production";
    vi.resetModules();
    const { shouldRunProviderSmoke } = await import("../../../src/infra/provider-config.js");
    expect(shouldRunProviderSmoke()).toBe(true);
  });

  it("shouldRunProviderSmoke is false in development by default", async () => {
    process.env["NODE_ENV"] = "development";
    vi.resetModules();
    const { shouldRunProviderSmoke } = await import("../../../src/infra/provider-config.js");
    expect(shouldRunProviderSmoke()).toBe(false);
  });

  // 2026-07-12: PROD_DOTENV rendered `GWS_BIN=` (present but EMPTY) → execFile("")
  // → "The argument 'file' cannot be empty" on every gws probe. Empty must mean unset.
  it("getGwsBin falls back to PATH resolution when GWS_BIN is empty", async () => {
    process.env["GWS_BIN"] = "";
    vi.resetModules();
    const { getGwsBin } = await import("../../../src/infra/provider-config.js");
    expect(getGwsBin()).toBe("gws");
  });

  it("getGwsBin falls back when GWS_BIN is whitespace", async () => {
    process.env["GWS_BIN"] = "   ";
    vi.resetModules();
    const { getGwsBin } = await import("../../../src/infra/provider-config.js");
    expect(getGwsBin()).toBe("gws");
  });

  it("getGwsBin honours an explicit binary path", async () => {
    process.env["GWS_BIN"] = "/home/founderos/.local/bin/gws";
    vi.resetModules();
    const { getGwsBin } = await import("../../../src/infra/provider-config.js");
    expect(getGwsBin()).toBe("/home/founderos/.local/bin/gws");
  });
});
