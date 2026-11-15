import { describe, expect, it } from "vitest";
import { autoApplyKeyboard, parseAutoApplyCallback, parseAutoApplyVerb, renderAutoApplyStatus } from "../../../src/gateway/autoapply-command.js";

describe("/autoapply", () => {
  it("parses on, off, status and bare as status; junk is null", () => {
    expect(parseAutoApplyVerb("on")).toBe("on");
    expect(parseAutoApplyVerb(" OFF ")).toBe("off");
    expect(parseAutoApplyVerb("")).toBe("status");
    expect(parseAutoApplyVerb("maybe")).toBeNull();
  });
  it("status shows both switches, today's count against the cap and the last sends", () => {
    const html = renderAutoApplyStatus({
      profileId: "p1", envOn: true, runtimeOn: false, sentToday: 3, cap: 10,
      last: [{ company: "Acme", title: "Engineer", at: new Date("2026-11-15T09:30:00Z"), result: "confirmed" }],
    });
    expect(html).toContain("OFF");
    expect(html).toContain("Today: 3 of 10");
    expect(html).toContain("2026-11-15 09:30 UTC Acme, Engineer: confirmed");
  });
  it("shows ON only when both switches are on", () => {
    const base = { profileId: "p1", sentToday: 0, cap: 10, last: [] };
    expect(renderAutoApplyStatus({ ...base, envOn: true, runtimeOn: true })).toContain("ON");
    expect(renderAutoApplyStatus({ ...base, envOn: false, runtimeOn: true })).toContain("OFF");
  });
});

describe("/autoapply buttons", () => {
  const data = (kb: ReturnType<typeof autoApplyKeyboard>): string[] => kb.inline_keyboard.flat().map((b) => (b as { callback_data: string }).callback_data);
  it("offers the opposite switch plus refresh, all inside Telegram's 64-byte cap", () => {
    expect(data(autoApplyKeyboard({ profileId: "p1", runtimeOn: false }))).toEqual(["jh:aa:on:p1", "jh:aa:status:p1"]);
    expect(data(autoApplyKeyboard({ profileId: "p1", runtimeOn: true }))).toEqual(["jh:aa:off:p1", "jh:aa:status:p1"]);
  });
  it("parses its own payloads and rejects junk", () => {
    expect(parseAutoApplyCallback("jh:aa:on:p1")).toEqual({ verb: "on", profileId: "p1" });
    expect(parseAutoApplyCallback("jh:aa:status:tashi-x")).toEqual({ verb: "status", profileId: "tashi-x" });
    expect(parseAutoApplyCallback("jh:aa:maybe:p1")).toBeNull();
    expect(parseAutoApplyCallback("jh:aa:on:")).toBeNull();
    expect(parseAutoApplyCallback("jh:g:p1:x")).toBeNull();
  });
  it("status leads with the state and drops the switch line when both are on", () => {
    const base = { profileId: "p1", sentToday: 0, cap: 10, last: [] };
    const on = renderAutoApplyStatus({ ...base, envOn: true, runtimeOn: true });
    expect(on.split("\n")[0]).toContain("ON");
    expect(on).not.toContain("Both must be on");
    expect(renderAutoApplyStatus({ ...base, envOn: true, runtimeOn: false })).toContain("Both must be on");
  });
});
