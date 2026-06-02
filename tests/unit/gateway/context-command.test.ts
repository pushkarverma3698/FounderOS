/**
 * Unit tests for /context command parser and formatter.
 *
 * RED: fails until src/gateway/context-command.ts is implemented.
 */

import { describe, it, expect } from "vitest";
import { parseContextCommand, formatContextDisplay } from "../../../src/gateway/context-command.js";

// ── parseContextCommand ───────────────────────────────────────────────────────

describe("parseContextCommand", () => {
  it("returns { action: 'show' } with no args", () => {
    expect(parseContextCommand("")).toEqual({ action: "show" });
  });

  it("returns { action: 'show' } for 'show'", () => {
    expect(parseContextCommand("show")).toEqual({ action: "show" });
  });

  it("parses 'set active_clients Acme Corp, Beta Ltd'", () => {
    const result = parseContextCommand("set active_clients Acme Corp, Beta Ltd");
    expect(result).toEqual({
      action: "set",
      key: "active_clients",
      value: "Acme Corp, Beta Ltd",
    });
  });

  it("parses 'set current_priorities Ship Phase D'", () => {
    const result = parseContextCommand("set current_priorities Ship Phase D");
    expect(result).toEqual({
      action: "set",
      key: "current_priorities",
      value: "Ship Phase D",
    });
  });

  it("returns error for 'set' with no key", () => {
    const result = parseContextCommand("set");
    expect(result).toEqual({ action: "error", message: expect.stringContaining("key") });
  });

  it("returns error for 'set key' with no value", () => {
    const result = parseContextCommand("set active_clients");
    expect(result).toEqual({ action: "error", message: expect.stringContaining("value") });
  });

  it("returns error for unrecognized subcommand", () => {
    const result = parseContextCommand("delete active_clients");
    expect(result).toEqual({ action: "error", message: expect.any(String) });
  });
});

// ── formatContextDisplay ──────────────────────────────────────────────────────

describe("formatContextDisplay", () => {
  it("returns empty-state message when context is empty", () => {
    const msg = formatContextDisplay({});
    expect(msg).toMatch(/no context|empty|not set/i);
  });

  it("displays active_clients array as a readable list", () => {
    const msg = formatContextDisplay({ active_clients: ["Acme Corp", "Beta Ltd"] });
    expect(msg).toContain("Acme Corp");
    expect(msg).toContain("Beta Ltd");
  });

  it("skips the last_updated key in display", () => {
    const msg = formatContextDisplay({ focus: "ship", last_updated: "2026-06-01T00:00:00Z" });
    expect(msg).not.toContain("last_updated");
    expect(msg).toContain("focus");
  });

  it("shows all keys with their values", () => {
    const msg = formatContextDisplay({
      active_clients: ["Acme"],
      current_priorities: ["close deals"],
      open_deals: ["Acme $5k"],
    });
    expect(msg).toContain("active_clients");
    expect(msg).toContain("current_priorities");
    expect(msg).toContain("open_deals");
  });
});
