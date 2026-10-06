/** The planner's "Offered vs Ran" decision must equal the gateway's "ask for a tap" decision, for every command. */
import { describe, expect, it } from "vitest";
import { commandNeedsTap } from "../../../src/kernel/index.js";
import { needsConfirmation, plannableCommands } from "../../../src/gateway/command-catalog.js";

describe("commandNeedsTap parity with needsConfirmation", () => {
  const entries = plannableCommands();

  it("catalog is non-empty", () => {
    expect(entries.length).toBeGreaterThan(5);
  });

  for (const entry of entries) {
    for (const args of ["", "   ", "some words"]) {
      it("/" + entry.name + " args=" + JSON.stringify(args), () => {
        expect(commandNeedsTap(entry, args)).toBe(needsConfirmation(entry.name, args));
      });
    }
  }

  it("fills writesWithArgs for the read-only-bare commands", () => {
    const by = Object.fromEntries(entries.map((c) => [c.name, c.writesWithArgs]));
    expect(by["focus"]).toBe(true);
    expect(by["where"]).toBe(false);
  });
});
