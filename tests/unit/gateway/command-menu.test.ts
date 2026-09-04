/**
 * Unit tests — the command menu Telegram itself renders.
 *
 * WHY THIS EXISTS. Until 2026-08-21 the only way to learn a command was to type
 * `/commands` and read a message — which requires already knowing that
 * `/commands` exists. The founder asked the obvious question ("how can i get to
 * know all the commands") and the honest answer was: you can't, unless you
 * remember. Telegram has a native menu for exactly this (`setMyCommands`), which
 * puts every command one tap away in the client's own UI, and it was never
 * called.
 *
 * ONE LIST, THREE CONSUMERS. The menu, the `/commands` help text and the actual
 * `bot.command(...)` registrations must agree. They did not before: `/start`
 * advertised twelve commands that had been deleted with the v2 orchestration
 * layers. Drift between a help screen and reality is not a documentation
 * problem — it is a founder typing a command into a bot that ignores him.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { COMMAND_MENU, buildCommandsHelp } from "../../../src/gateway/command-menu.js";

/** The commands actually wired up, read from the transport file itself. */
function registeredCommands(): string[] {
  const source = readFileSync("src/gateway/telegram.ts", "utf-8");
  return [...source.matchAll(/\.command\("([a-z_]+)"/g)].map((m) => m[1] as string);
}

describe("COMMAND_MENU — valid for Telegram's setMyCommands", () => {
  it("uses only characters Telegram accepts in a command name", () => {
    // Telegram rejects the whole setMyCommands call on one bad entry, so a
    // typo here silently costs the founder the entire menu.
    for (const entry of COMMAND_MENU) {
      expect(entry.command).toMatch(/^[a-z0-9_]{1,32}$/);
    }
  });

  it("gives every command a description within the 256-char limit", () => {
    for (const entry of COMMAND_MENU) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeLessThanOrEqual(256);
    }
  });

  it("uses plain text in descriptions — the native menu does not parse HTML", () => {
    // `/commands` renders HTML; this menu does not. A `<n>` here prints the
    // tag characters at the founder instead of being read as a placeholder.
    for (const entry of COMMAND_MENU) {
      expect(entry.description).not.toMatch(/[<>&]/);
    }
  });

  it("lists no command twice", () => {
    const names = COMMAND_MENU.map((e) => e.command);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("COMMAND_MENU — agrees with what the bot actually answers", () => {
  it("advertises nothing that is not registered", () => {
    const registered = new Set(registeredCommands());
    const phantom = COMMAND_MENU.map((e) => e.command).filter((c) => !registered.has(c));
    expect(phantom).toEqual([]);
  });

  it("advertises every command that is registered", () => {
    // The inverse direction matters just as much: a working command nobody can
    // discover is indistinguishable from one that does not exist.
    const advertised = new Set(COMMAND_MENU.map((e) => e.command));
    const hidden = registeredCommands().filter((c) => !advertised.has(c));
    expect(hidden).toEqual([]);
  });

  it("puts the jobs loop at the top, where the menu is read", () => {
    const first = COMMAND_MENU.slice(0, 5).map((e) => e.command);
    expect(first).toContain("jobs");
    expect(first).toContain("csv");
    expect(first).toContain("draft");
  });
});

describe("buildCommandsHelp — the same list, rendered for chat", () => {
  it("names every command in the menu", () => {
    const help = buildCommandsHelp().join("\n");
    for (const entry of COMMAND_MENU) {
      expect(help).toContain(`/${entry.command}`);
    }
  });

  it("escapes placeholders so Telegram does not read them as tags", () => {
    // "/draft <n>" sent as HTML is the exact defect that killed /jobs.
    const help = buildCommandsHelp().join("\n");
    expect(help).not.toMatch(/<n>/);
    expect(help).toContain("&lt;n&gt;");
  });

  it("tells him the menu button exists — otherwise he still has to remember", () => {
    expect(buildCommandsHelp().join("\n")).toMatch(/menu/i);
  });
});
