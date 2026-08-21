/**
 * Unit tests — the /start and restart copy.
 *
 * REWRITTEN 2026-08-21. This file previously asserted that the welcome message
 * contained `/help`, `MISO` and `JARVIS`, and that the restart notice contained
 * `miso_start`. All four named surfaces that no longer exist — the v2 command
 * set died with the v2 orchestration layers (see the header of `commands.ts`) —
 * so the tests were holding twelve dead buttons in place on the first screen a
 * founder sees, and passing while they did it.
 *
 * The assertions now run the other way: the copy must NOT name a command that
 * has no handler. `advertised-commands.test.ts` enforces that against the real
 * registration list in `telegram.ts`; this file pins the human-facing shape.
 */

import { describe, it, expect } from "vitest";
import { buildWelcomeMessage, buildRestartMessage } from "../../../src/gateway/capability-message.js";

/** Commands deleted with the v2 layers. Naming any of them is the regression. */
const DEAD_V2_COMMANDS = [
  "/help",
  "/miso_start",
  "/miso_plan",
  "/miso_status",
  "/workflows",
  "/target",
  "/outbound",
  "/proofdrop",
  "/signals",
  "/runs",
  "/ping",
  "/departments",
];

describe("capability-message", () => {
  it("welcome greets by name and still lists every department", () => {
    const msg = buildWelcomeMessage("Pushkar");
    expect(msg).toContain("Pushkar");
    expect(msg).toContain("Admin");
    expect(msg).toContain("Research");
    expect(msg).toContain("Personal");
    expect(msg).toContain("✋");
  });

  it("welcome leads with the jobs loop and its real commands", () => {
    const msg = buildWelcomeMessage();
    expect(msg).toContain("/jobs");
    expect(msg).toContain("/csv");
    expect(msg).toContain("/draft");
  });

  it("welcome names no command that was deleted with the v2 layers", () => {
    const msg = buildWelcomeMessage("Pushkar");
    expect(DEAD_V2_COMMANDS.filter((c) => msg.includes(c))).toEqual([]);
  });

  it("restart message points to /start and lists departments", () => {
    const msg = buildRestartMessage();
    expect(msg).toContain("back online");
    expect(msg).toContain("admin");
    expect(msg).toContain("jobhunt");
    expect(msg).toContain("/start");
    expect(msg).toContain("/status");
  });

  it("restart message names no command that was deleted with the v2 layers", () => {
    const msg = buildRestartMessage();
    expect(DEAD_V2_COMMANDS.filter((c) => msg.includes(c))).toEqual([]);
  });
});
