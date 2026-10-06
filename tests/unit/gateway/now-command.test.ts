/**
 * P2-4 and C-P1-3. `/commands` is one screen (the home lanes) with a button for the full list, and `/now`
 * is three lines, each with one button: coding, jobs, ops.
 */

import { describe, it, expect } from "vitest";
import { buildMenuKeyboardRows, FULL_LIST_CALLBACK } from "../../../src/gateway/home-menu.js";
import { formatNow, nowKeyboardRows, type NowData } from "../../../src/gateway/now-command.js";
import { COMMAND_MENU } from "../../../src/gateway/command-menu.js";
import { OWNER_ONLY_COMMANDS } from "../../../src/gateway/chat-access.js";

const BUSY: NowData = {
  coding: { working: 2, needsYou: 1, readyToMerge: 3, unreachable: 0 },
  jobs: { ready: 12, profileId: "pushkar-nl-tech" },
  ops: { pendingApprovals: 2 },
};

describe("/commands on one screen", () => {
  it("the home screen carries a button for the full list", () => {
    const flat = buildMenuKeyboardRows("home").flat();
    expect(flat.map((b) => b.callback_data)).toContain(FULL_LIST_CALLBACK);
  });

  it("no other section offers it: the full list is one tap from home only", () => {
    for (const section of ["build", "jobs", "system", "wife"] as const) {
      expect(buildMenuKeyboardRows(section).flat().map((b) => b.callback_data)).not.toContain(FULL_LIST_CALLBACK);
    }
  });
});

describe("/now", () => {
  it("is in the command menu and owner-only", () => {
    expect(COMMAND_MENU.some((e) => e.command === "now")).toBe(true);
    expect(OWNER_ONLY_COMMANDS.has("now")).toBe(true);
  });

  it("says each of the three lines in one row", () => {
    const text = formatNow(BUSY);
    expect(text.split("\n").filter((l) => /^(🤖|🎯|⚡)/.test(l))).toHaveLength(3);
    expect(text).toContain("2 working");
    expect(text).toContain("1 needs you");
    expect(text).toContain("3 ready to merge");
    expect(text).toContain("12 ready to apply");
    expect(text).toContain("2 waiting on your approval");
  });

  it("each line has exactly one button", () => {
    const rows = nowKeyboardRows(BUSY);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toHaveLength(1);
  });

  it("says plainly when there is nothing, instead of printing zeros", () => {
    const text = formatNow({
      coding: { working: 0, needsYou: 0, readyToMerge: 0, unreachable: 0 },
      jobs: { ready: 0, profileId: "pushkar-nl-tech" },
      ops: { pendingApprovals: 0 },
    });
    expect(text).toContain("nothing running");
    expect(text).toContain("no roles ready");
    expect(text).toContain("nothing waiting");
  });

  it("never hides a repo it could not read", () => {
    const text = formatNow({ ...BUSY, coding: { ...BUSY.coding, unreachable: 2 } });
    expect(text).toContain("2 repos unreadable");
  });
});
