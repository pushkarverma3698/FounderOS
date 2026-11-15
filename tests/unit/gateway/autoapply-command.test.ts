import { describe, expect, it } from "vitest";
import { parseAutoApplyVerb, renderAutoApplyStatus } from "../../../src/gateway/autoapply-command.js";

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
