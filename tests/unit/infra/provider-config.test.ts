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
    delete process.env["GWS_BIN"];
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("defaults Gmail backend to gws", async () => {
    vi.resetModules();
    const { getGmailBackend } = await import("../../../src/infra/provider-config.js");
    expect(getGmailBackend()).toBe("gws");
  });

  it("getGwsBin defaults to 'gws' when unset", async () => {
    vi.resetModules();
    const { getGwsBin } = await import("../../../src/infra/provider-config.js");
    expect(getGwsBin()).toBe("gws");
  });

  it("getGwsBin falls back to 'gws' on an EMPTY GWS_BIN (never exec '')", async () => {
    // Regression: prod .env carried `GWS_BIN=` (empty) → execFile("") →
    // "The argument 'file' cannot be empty" → Gmail down 2026-07-01.
    process.env["GWS_BIN"] = "";
    vi.resetModules();
    const { getGwsBin } = await import("../../../src/infra/provider-config.js");
    expect(getGwsBin()).toBe("gws");
  });

  it("getGwsBin honours an explicit GWS_BIN path", async () => {
    process.env["GWS_BIN"] = "/usr/local/bin/gws";
    vi.resetModules();
    const { getGwsBin } = await import("../../../src/infra/provider-config.js");
    expect(getGwsBin()).toBe("/usr/local/bin/gws");
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
});
