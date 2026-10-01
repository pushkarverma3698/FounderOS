/**
 * Which Telegram commands a guest in an allow-listed group may not run.
 * ====================================================================
 * Three branches each added names to OWNER_ONLY_COMMANDS (focus and projects; goal and goals),
 * on top of the system commands that were already there. A merge that drops one line silently
 * hands a guest the founder's context or his goals, and nothing else would notice: the commands
 * still work for him. This pins the whole set in one place.
 */

import { describe, it, expect } from "vitest";
import { OWNER_ONLY_COMMANDS } from "../../../src/gateway/chat-access.js";

const SYSTEM_COMMANDS = ["halt", "resume", "task", "newproject", "connect"];
/** Commands that read or write the founder's own data: his focus and projects, his goals. */
const FOUNDER_DATA_COMMANDS = ["focus", "projects", "goal", "goals"];

describe("OWNER_ONLY_COMMANDS", () => {
  it.each([...SYSTEM_COMMANDS, ...FOUNDER_DATA_COMMANDS])("refuses a guest the /%s command", (command) => {
    expect(OWNER_ONLY_COMMANDS.has(command)).toBe(true);
  });

  it("holds exactly these commands: a new entry is a decision, made here on purpose", () => {
    expect([...OWNER_ONLY_COMMANDS].sort()).toEqual([...SYSTEM_COMMANDS, ...FOUNDER_DATA_COMMANDS].sort());
  });
});
