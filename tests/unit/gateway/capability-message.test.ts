import { describe, it, expect } from "vitest";
import { buildWelcomeMessage, buildRestartMessage } from "../../../src/gateway/capability-message.js";

describe("capability-message", () => {
  it("welcome lists all 8 departments with examples", () => {
    const msg = buildWelcomeMessage("Pushkar");
    expect(msg).toContain("Pushkar");
    expect(msg).toContain("Admin");
    expect(msg).toContain("Research");
    expect(msg).toContain("Personal");
    expect(msg).toContain("Jobhunt");
    expect(msg).toContain("/help");
    expect(msg).toContain("MISO");
    expect(msg).toContain("JARVIS");
    expect(msg).toContain("✋");
  });

  it("restart message points to /start and lists departments", () => {
    const msg = buildRestartMessage();
    expect(msg).toContain("back online");
    expect(msg).toContain("admin");
    expect(msg).toContain("jobhunt");
    expect(msg).toContain("/start");
    expect(msg).toContain("/status");
    expect(msg).toContain("miso_start");
    expect(msg).toContain("JARVIS");
  });
});
