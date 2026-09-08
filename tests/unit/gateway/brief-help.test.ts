/**
 * Unit tests — B7: the surface is discoverable, including the English half.
 *
 * The founder's question on 2026-08-21 was "how can i get to know all the
 * commands", and the honest answer then was: you can't. That was fixed by
 * COMMAND_MENU, but the fix only covers slash commands — and after this change
 * half the surface is a sentence. "tashi's last 2 days jobs founded" is a
 * capability nobody can discover from a menu of slash commands, so the help has
 * to say it out loud with real examples.
 *
 * The second thing it has to say is the DISTINCTION. `posted` and `found` are
 * two different questions with two different answers, and they only diverge
 * when a board is added — which is exactly when the founder will be surprised
 * and will not know which one he asked.
 */

import { describe, it, expect } from "vitest";
import { buildCommandsHelp, COMMAND_MENU } from "../../../src/gateway/command-menu.js";

const help = buildCommandsHelp().join("\n");

describe("B7 — all three read verbs are advertised", () => {
  it.each(["/fresh", "/today", "/jobs"])("names %s", (command) => {
    expect(help).toContain(command);
  });

  it("names each one's counterpart for the other candidate", () => {
    for (const command of ["/wife_fresh", "/wife_today", "/wife_jobs"]) {
      expect(help).toContain(command);
    }
  });

  it("says what distinguishes them, not just that they exist", () => {
    expect(help).toContain("since you last looked");
    expect(help).toContain("last 24h");
    expect(help).toContain("Everything on file");
  });

  it("mentions the range argument, which is invisible otherwise", () => {
    expect(help).toMatch(/jobs 3d|fresh 2d/);
  });
});

describe("B7 — the English surface is discoverable", () => {
  it("gives real example sentences, not the word 'natural language'", () => {
    expect(help).toContain("tashi's jobs");
    expect(help).toContain("tashi's last 2 days jobs founded");
  });

  it("defines posted vs found, the one distinction that will surprise him", () => {
    expect(help).toContain("when the employer published it");
    expect(help).toContain("when we first saw it");
  });
});

describe("B7 — the menu payload stays legal for Telegram", () => {
  it("keeps every command name inside setMyCommands' character rules", () => {
    // Telegram rejects the WHOLE setMyCommands call on one bad name, which
    // would silently take the ☰ menu down for every command at once.
    for (const entry of COMMAND_MENU) {
      expect(entry.command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(entry.description.length).toBeLessThanOrEqual(256);
    }
  });

  it("keeps the native menu descriptions free of markup", () => {
    // The native menu does not parse HTML: a "<n>" there prints as three
    // characters. Only the chat rendering may carry tags.
    for (const entry of COMMAND_MENU) {
      expect(entry.description).not.toMatch(/[<>]/);
    }
  });
});
