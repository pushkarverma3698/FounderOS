/**
 * Unit tests — the tappable home screen.
 *
 * The regression this file exists to stop is the one that already happened
 * twice: a first screen advertising commands the bot does not answer. On
 * 2026-08-21 `/start` named twelve that had been deleted with the v2 layers, and
 * every one landed on "unknown command" — a menu of dead buttons teaches the
 * founder not to trust the live ones either. Now that the copy also carries
 * literal buttons, the same property has to hold for both.
 */

import { describe, it, expect } from "vitest";
import type { Context } from "grammy";
import {
  MENU_CALLBACK_PREFIX,
  MENU_SECTIONS,
  buildMenuKeyboardRows,
  buildMenuSection,
  handleMenuCallback,
  isMenuSection,
  menuKeyboard,
  type MenuSection,
} from "../../../src/gateway/home-menu.js";
import { COMMAND_MENU } from "../../../src/gateway/command-menu.js";
import { buildWifeCommandsHelp } from "../../../src/gateway/wife-commands.js";
import { CAPABILITIES_CALLBACK, DEPARTMENT_LABELS } from "../../../src/gateway/capabilities-screen.js";
import { WORKERS } from "../../../src/kernel/contracts.js";
import { TELEGRAM_MAX_CHARS } from "../../../src/tools/jobhunt/telegram-format.js";

// Every section the module has — a new one is covered by every check below.
const SECTIONS: MenuSection[] = [...MENU_SECTIONS];

/** The `/commands` a section names, tags stripped (`</b>` is not a command). */
const namedIn = (text: string): string[] =>
  [...text.replace(/<[^>]*>/g, " ").matchAll(/\/([a-z_]+)/g)].map((m) => m[1] as string);

describe("/start — nothing the ☰ menu offers is missing from the screens", () => {
  it("names every visible command on some screen", () => {
    // 2026-09-28: /replied and /rejected were missing from the Jobs screen and
    // /remind from the System screen, while all three sat in the ☰ menu.
    const named = new Set(SECTIONS.flatMap((s) => namedIn(buildMenuSection(s))));
    const missing = COMMAND_MENU.filter((e) => !e.hidden && !named.has(e.command)).map((e) => e.command);
    expect(missing).toEqual([]);
  });

  it("puts Tashi's commands one tap from the Jobs screen, rendered like /wife_commands", () => {
    const jobsButtons = buildMenuKeyboardRows("jobs").flat().map((b) => b.callback_data);
    expect(jobsButtons).toContain(`${MENU_CALLBACK_PREFIX}wife`);
    expect(buildMenuSection("wife")).toBe(buildWifeCommandsHelp());
  });
});

describe("/start — everything the system can do is one tap away", () => {
  it("offers 🧭 Everything I can do on the home screen", () => {
    const home = buildMenuKeyboardRows("home").flat();
    expect(home.map((b) => b.callback_data)).toContain(CAPABILITIES_CALLBACK);
    expect(home.find((b) => b.callback_data === CAPABILITIES_CALLBACK)?.text).toMatch(/Everything I can do/);
  });

  it("names every team in the 'just talk to me' list, jobhunt included", () => {
    // It listed seven and left out jobhunt, the lane used daily (2026-09-28).
    // Scoped to that list: "Jobs" is also a lane name higher up the screen.
    const home = buildMenuSection("home");
    const teams = home.slice(home.indexOf("just talk to me"));
    for (const w of WORKERS) expect(teams, w).toContain(DEPARTMENT_LABELS[w].label);
  });

  it("sends the whole tool list when tapped, ending on the menu", async () => {
    const replies: Array<{ text: string; markup?: unknown }> = [];
    const answered: unknown[] = [];
    const ctx = {
      callbackQuery: { data: CAPABILITIES_CALLBACK },
      answerCallbackQuery: async (o?: unknown) => void answered.push(o ?? null),
      reply: async (text: string, opts?: { reply_markup?: unknown }) => void replies.push({ text, markup: opts?.reply_markup }),
    } as unknown as Context;
    expect(await handleMenuCallback(ctx)).toBe(true);
    expect(answered).toHaveLength(1);
    const all = replies.map((r) => r.text).join("\n");
    for (const w of WORKERS) expect(all, w).toContain(`<b>${DEPARTMENT_LABELS[w].label}</b>`);
    expect(replies.at(-1)?.markup).toBeDefined();
  });
});

describe("buildMenuSection — every command named is a command that answers", () => {
  it("names no command that is not registered", () => {
    const registered = new Set(COMMAND_MENU.map((e) => e.command));
    // Tags are stripped first: `</b>` and `</code>` are not commands, and a
    // scanner that counts them reports every section as advertising a dead one.
    const named = SECTIONS.flatMap((s) => [
      ...buildMenuSection(s).replace(/<[^>]*>/g, " ").matchAll(/\/([a-z_]+)/g),
    ]).map((m) => m[1] as string);

    expect(named.length).toBeGreaterThan(0);
    expect([...new Set(named)].filter((c) => !registered.has(c))).toEqual([]);
  });

  it("puts the engineering loop one tap away, not twenty-three scrolls down", () => {
    // The ☰ menu has 33 entries. /task sat at number 23, under 22 job commands.
    const build = buildMenuSection("build");
    expect(build).toContain("/task");
    expect(build).toContain("/tasks");
    expect(build).toContain("/newproject");
  });

  it("explains what happens AFTER /task, including the screenshots", () => {
    // The loop runs unattended for 20–40 minutes and posts twice. A founder who
    // does not know a photo is coming reads the silence as failure and the photo
    // as noise.
    const build = buildMenuSection("build");
    expect(build).toMatch(/photograph/i);
    expect(build).toMatch(/approve/i);
    expect(build).toMatch(/review/i);
  });

  it("names the repos in words rather than as slugs to be typed", () => {
    const build = buildMenuSection("build");
    expect(build).toContain("Oplify app");
    expect(build).toContain("Hulda");
    expect(build).toMatch(/merge yourself/i);
  });

  it("greets by name on the home screen only", () => {
    expect(buildMenuSection("home", "Pushkar")).toContain("Pushkar");
  });

  it("keeps every section inside Telegram's hard character cap", () => {
    // A section over 4,096 is rejected whole: the founder gets an error instead
    // of the part that would have fitted.
    for (const section of SECTIONS) {
      const text = buildMenuSection(section);
      expect(text.length).toBeLessThan(TELEGRAM_MAX_CHARS);
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps the jobs lane reachable from the first screen", () => {
    const home = buildMenuSection("home");
    for (const command of ["/jobs", "/csv", "/draft", "/task", "/status"]) {
      expect(home).toContain(command);
    }
  });
});

describe("buildMenuKeyboardRows", () => {
  it("never offers the section already on screen", () => {
    // Telegram rejects an edit that changes nothing, so a self-referencing button
    // is both a dead button and a thrown error.
    for (const section of SECTIONS) {
      const data = buildMenuKeyboardRows(section).flat().map((b) => b.callback_data);
      expect(data).not.toContain(`${MENU_CALLBACK_PREFIX}${section}`);
    }
  });

  it("always offers a way back out of a section", () => {
    for (const section of SECTIONS.filter((s) => s !== "home")) {
      const data = buildMenuKeyboardRows(section).flat().map((b) => b.callback_data);
      expect(data).toContain(`${MENU_CALLBACK_PREFIX}home`);
    }
  });

  it("leads the home screen with the lane the founder came here to find", () => {
    expect(buildMenuKeyboardRows("home")[0]?.[0]?.callback_data).toBe(`${MENU_CALLBACK_PREFIX}build`);
  });

  it("stays inside Telegram's 64-byte callback budget", () => {
    for (const section of SECTIONS) {
      for (const button of buildMenuKeyboardRows(section).flat()) {
        expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe("isMenuSection", () => {
  it("accepts the real sections and rejects anything else", () => {
    for (const section of SECTIONS) expect(isMenuSection(section)).toBe(true);
    expect(isMenuSection("approve")).toBe(false);
    expect(isMenuSection("")).toBe(false);
  });
});

describe("handleMenuCallback", () => {
  function ctxFor(data: string, over: Record<string, unknown> = {}) {
    const edits: string[] = [];
    const replies: string[] = [];
    const answered: unknown[] = [];
    const ctx = {
      callbackQuery: { data },
      from: { first_name: "Pushkar" },
      answerCallbackQuery: async (o?: unknown) => void answered.push(o ?? null),
      editMessageText: async (text: string) => void edits.push(text),
      reply: async (text: string) => void replies.push(text),
      ...over,
    } as unknown as Context;
    return { ctx, edits, replies, answered };
  }

  it("re-renders the tapped section in place", async () => {
    const { ctx, edits, replies } = ctxFor(`${MENU_CALLBACK_PREFIX}build`);
    expect(await handleMenuCallback(ctx)).toBe(true);
    expect(edits[0]).toContain("/task");
    // Editing, not appending: a help screen that appends pushes what you were
    // reading off the top of the phone.
    expect(replies).toHaveLength(0);
  });

  it("falls back to a fresh message when the edit fails, rather than going silent", async () => {
    const { ctx, replies } = ctxFor(`${MENU_CALLBACK_PREFIX}jobs`, {
      editMessageText: async () => {
        throw new Error("message is not modified");
      },
    });
    expect(await handleMenuCallback(ctx)).toBe(true);
    expect(replies[0]).toContain("/draft");
  });

  it("ignores a callback that is not ours, so approve/reject still reach the HITL path", async () => {
    for (const data of ["approve", "reject", "task:repo:oplify-messaging-app"]) {
      expect(await handleMenuCallback(ctxFor(data).ctx)).toBe(false);
    }
  });

  it("answers an unknown section instead of leaving the button spinning", async () => {
    const { ctx, answered } = ctxFor(`${MENU_CALLBACK_PREFIX}nonsense`);
    expect(await handleMenuCallback(ctx)).toBe(true);
    expect(JSON.stringify(answered)).toMatch(/unknown section/i);
  });
});

describe("menuKeyboard", () => {
  it("wraps the rows in the shape grammy wants", () => {
    expect(menuKeyboard("home")).toHaveProperty("inline_keyboard");
  });
});
