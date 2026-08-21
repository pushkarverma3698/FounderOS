/**
 * Unit test — every command the bot advertises must be a command the bot has.
 *
 * WHY. On 2026-08-21 the /start screen named twelve commands that did not
 * exist: /target, /outbound, /proofdrop, /signals, /runs, /ping, /departments,
 * /help, /workflows, /run, /q and four /miso_* variants. They died with the v2
 * orchestration layers (see the header of `commands.ts`) and nothing updated the
 * copy, so the first screen a founder saw was mostly dead buttons — each one
 * landing on `unknownCommandReply`. That teaches him the live commands are a
 * coin flip too, which is the expensive part: `/draft` went un-typed for seven
 * straight days while it worked perfectly.
 *
 * This is the mechanism that keeps the copy honest, rather than a note asking
 * the next person to remember (rule #27: a rule with no mechanism decays).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildWelcomeMessage, buildRestartMessage } from "../../../src/gateway/capability-message.js";

/** The commands actually wired to a handler, read from the transport file itself. */
function registeredCommands(): Set<string> {
  const source = readFileSync(new URL("../../../src/gateway/telegram.ts", import.meta.url), "utf8");
  return new Set([...source.matchAll(/\.command\("([a-z_]+)"/g)].map((m) => m[1]!));
}

/** Commands mentioned in a message, ignoring HTTP paths like /api/v1/health. */
function advertisedCommands(text: string): string[] {
  return [...text.matchAll(/(?:^|[\s>(])\/([a-z_]{2,})\b/g)]
    .map((m) => m[1]!)
    .filter((name) => !text.includes(`/${name}/`));
}

describe("advertised commands", () => {
  it("the /start screen names only commands that are registered", () => {
    const registered = registeredCommands();
    const missing = advertisedCommands(buildWelcomeMessage("Pushkar")).filter(
      (name) => !registered.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("the restart notice names only commands that are registered", () => {
    const registered = registeredCommands();
    const missing = advertisedCommands(buildRestartMessage()).filter(
      (name) => !registered.has(name),
    );
    expect(missing).toEqual([]);
  });

  it("leads with the jobs loop — the thing used daily comes before the plumbing", () => {
    const welcome = buildWelcomeMessage();
    expect(welcome.indexOf("/jobs")).toBeLessThan(welcome.indexOf("/status"));
  });

  it("registers the two commands that replaced the never-configured Sheet", () => {
    const registered = registeredCommands();
    expect(registered.has("jobs")).toBe(true);
    expect(registered.has("csv")).toBe(true);
  });
});
