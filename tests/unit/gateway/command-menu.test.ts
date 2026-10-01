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
import type { Context } from "grammy";
import { COMMAND_MENU, buildCommandsHelp, telegramCommandPayload } from "../../../src/gateway/command-menu.js";
import { buildWifeCommandsHelp, handleWifeCommands } from "../../../src/gateway/wife-commands.js";
import { TELEGRAM_MAX_CHARS } from "../../../src/tools/jobhunt/telegram-format.js";

/** Files that call `bot.command(...)`: the transport, and the feature modules whose registration it delegates to. */
const COMMAND_SOURCES = ["src/gateway/telegram.ts", "src/gateway/goal-commands.ts"];

/** The commands actually wired up, read from those files themselves. */
function registeredCommands(): string[] {
  return COMMAND_SOURCES.flatMap((file) => [...readFileSync(file, "utf-8").matchAll(/\.command\("([a-z_]+)"/g)].map((m) => m[1] as string));
}

/** Every `/command` a rendered HTML message names. */
function namedCommands(html: string): Set<string> {
  return new Set([...html.replace(/<[^>]*>/g, " ").matchAll(/\/([a-z_]+)/g)].map((m) => m[1] as string));
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
    // Counted over the FOUNDER'S OWN commands, ignoring the paired `wife_`
    // entries that sit beside each one: the property is "the daily loop leads",
    // and after the 2026-09-08 surface change (three read verbs instead of one)
    // a flat slice of five would be testing how many candidates are registered
    // rather than what the menu leads with.
    const first = COMMAND_MENU.filter((e) => !e.command.startsWith("wife_"))
      .slice(0, 5)
      .map((e) => e.command);
    expect(first).toContain("fresh");
    expect(first).toContain("today");
    expect(first).toContain("jobs");
    expect(first).toContain("csv");
    expect(first).toContain("draft");
  });
});

describe("telegramCommandPayload — what the ☰ button actually shows", () => {
  it("drops exactly the eleven wife_ aliases, and nothing else", () => {
    // 2026-09-28: 34 rows, 11 of them near-identical wife_ twins. Every job
    // command already takes a profile word (`/jobs tashi`), so the twins leave
    // the menu — and stay registered, and stay listed (see /wife_commands).
    const hidden = COMMAND_MENU.filter((e) => e.hidden).map((e) => e.command);
    const shown = telegramCommandPayload().map((e) => e.command);
    expect(hidden).toHaveLength(11);
    expect(hidden.every((c) => c.startsWith("wife_"))).toBe(true);
    expect(shown).toHaveLength(COMMAND_MENU.length - 11);
    expect(shown.filter((c) => hidden.includes(c))).toEqual([]);
    expect(shown.sort()).toEqual(COMMAND_MENU.filter((e) => !e.hidden).map((e) => e.command).sort());
  });

  it("keeps every registered command reachable: in the ☰ menu or listed by /wife_commands", () => {
    // Hiding must not become losing. A command that is on no visible surface
    // can only be found by already knowing it (the founder, 2026-09-28: "make
    // sure … we don't lose the features").
    const visible = new Set([
      ...telegramCommandPayload().map((e) => e.command),
      ...namedCommands(buildWifeCommandsHelp()),
    ]);
    expect(registeredCommands().filter((c) => !visible.has(c))).toEqual([]);
  });

  it("puts /wife_commands in the menu, so her commands are one tap away", () => {
    expect(telegramCommandPayload().map((e) => e.command)).toContain("wife_commands");
  });

  it("puts the engineering loop above the fold instead of at number 23", () => {
    // Measured against the live bot on 2026-09-23: 33 entries, /task at 23, under
    // 22 job commands of which 11 were near-identical wife_ twins. Telegram shows
    // about eight rows at a time on a phone.
    const order = telegramCommandPayload().map((e) => e.command);
    expect(order.indexOf("task")).toBeLessThan(14);
    expect(order.indexOf("tasks")).toBeLessThan(14);
  });

  it("names the profile word on every job command that takes one", () => {
    // What replaces the twins in the menu: the kept row says how to reach hers.
    for (const entry of COMMAND_MENU.filter((e) => e.group === "jobs" && !e.hidden && e.command !== "wife_commands")) {
      expect(entry.description, entry.command).toMatch(/tashi/);
    }
  });

  it("preserves read order among the founder's own commands", () => {
    const own = (list: readonly { command: string }[]) =>
      list.map((e) => e.command).filter((c) => !c.startsWith("wife_"));
    expect(own(telegramCommandPayload())).toEqual(own(COMMAND_MENU));
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

  it("sends a handful of messages, not one per command", () => {
    // handleCommands awaits these in a tight loop and this bot registers no
    // throttler and no auto-retry, so the count IS the flood risk. The first
    // split rendered one message per command: 19 sends for 2,258 characters,
    // two of them a bare section heading.
    const parts = buildCommandsHelp();
    expect(parts.length).toBeLessThanOrEqual(4);
    expect(parts.length).toBeGreaterThan(1);
  });

  it("keeps every message inside Telegram's hard character cap", () => {
    // A section that outgrows 4,096 is rejected whole — the founder gets an
    // error instead of the half of the list that would have fitted.
    for (const part of buildCommandsHelp()) {
      expect(part.length).toBeLessThan(TELEGRAM_MAX_CHARS);
      expect(part.trim().length).toBeGreaterThan(0);
    }
  });

  it("pairs each job command with its wife_ counterpart in the same message", () => {
    // They are the same action against two candidates. Splitting them across
    // messages is what made the paired list unreadable.
    const [jobsMessage] = buildCommandsHelp();
    for (const entry of COMMAND_MENU.filter((e) => e.group === "jobs")) {
      expect(jobsMessage).toContain(`/${entry.command}`);
    }
  });

  it("covers every registered command, hidden aliases included, and names /wife_commands", () => {
    const named = namedCommands(buildCommandsHelp().join("\n"));
    expect(registeredCommands().filter((c) => !named.has(c))).toEqual([]);
    expect(named.has("wife_commands")).toBe(true);
  });
});

describe("/wife_commands — Tashi's commands, rendered from the one list", () => {
  const help = buildWifeCommandsHelp();

  it("lists exactly the hidden aliases — a new wife_ command that is not listed fails here", () => {
    const listed = [...namedCommands(help)].filter((c) => c.startsWith("wife_") && c !== "wife_commands").sort();
    expect(listed).toEqual(COMMAND_MENU.filter((e) => e.hidden).map((e) => e.command).sort());
  });

  it("hides every wife_ twin of a job command — a visible twin would bring the 34-row menu back", () => {
    // Job commands only: /wife_commands is not a twin of the system /commands.
    const base = new Set(
      COMMAND_MENU.filter((e) => e.group === "jobs" && !e.command.startsWith("wife_")).map((e) => e.command),
    );
    const twins = COMMAND_MENU.filter((e) => e.command.startsWith("wife_") && base.has(e.command.slice(5)));
    expect(twins.length).toBeGreaterThan(0);
    expect(twins.filter((e) => !e.hidden).map((e) => e.command)).toEqual([]);
  });

  it("gives every alias its description and a usage example", () => {
    for (const entry of COMMAND_MENU.filter((e) => e.hidden)) {
      expect(entry.example, entry.command).toMatch(new RegExp(`^/${entry.command}\\b`));
      expect(help).toContain(entry.example as string);
    }
  });

  it("says the profile word works too", () => {
    expect(help).toContain("/jobs tashi");
  });

  it("sends every part, split rather than truncated, inside Telegram's cap", async () => {
    const sent: string[] = [];
    const ctx = { reply: async (text: string) => void sent.push(text) } as unknown as Context;
    await handleWifeCommands(ctx);
    expect(sent.length).toBeGreaterThan(0);
    for (const part of sent) expect(part.length).toBeLessThan(TELEGRAM_MAX_CHARS);
    for (const entry of COMMAND_MENU.filter((e) => e.hidden)) {
      expect(sent.join("\n")).toContain(`/${entry.command}`);
    }
  });
});
