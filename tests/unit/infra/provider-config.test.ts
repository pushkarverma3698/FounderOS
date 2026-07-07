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
});
