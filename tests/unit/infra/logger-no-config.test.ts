/**
 * Regression: importing the logger must never require production secrets.
 *
 * scripts/qa-ui.ts's --vision path dynamically imports ui-vision.js, which
 * imports infra/logger.js. Before this fix, logger.js pulled the fully
 * validated `env` from core/config.ts just to read NODE_ENV/LOG_LEVEL — so a
 * CI run with no DATABASE_URL/TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID crashed on
 * logger import alone, taking the whole (otherwise $0, secret-free) UI QA gate
 * down with it. See docs/sessions/2026-09-16-ui-qa-vision-gate.md.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("infra/logger — importable with no config", () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    delete process.env["DATABASE_URL"];
    delete process.env["TELEGRAM_BOT_TOKEN"];
    delete process.env["TELEGRAM_CHAT_ID"];
  });

  afterEach(() => {
    process.env = { ...envBackup };
  });

  it("imports cleanly with DATABASE_URL, TELEGRAM_BOT_TOKEN, and TELEGRAM_CHAT_ID all unset", async () => {
    vi.resetModules();
    await expect(import("../../../src/infra/logger.js")).resolves.toBeDefined();
  });

  it("still honours LOG_LEVEL when core config is unavailable", async () => {
    process.env["LOG_LEVEL"] = "warn";
    vi.resetModules();
    const { logger } = await import("../../../src/infra/logger.js");
    expect(logger.level).toBe("warn");
  });

  it("defaults to info level when LOG_LEVEL is unset, matching core/config.ts's default", async () => {
    delete process.env["LOG_LEVEL"];
    vi.resetModules();
    const { logger } = await import("../../../src/infra/logger.js");
    expect(logger.level).toBe("info");
  });
});
