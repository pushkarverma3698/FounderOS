import { describe, expect, it } from "vitest";
import { historyText, plainDetail } from "../../../../src/gateway/login/login-audit.js";

describe("plainDetail", () => {
  it("strips tags and entities, collapses whitespace and caps at 200", () => {
    expect(plainDetail('<b>Failed</b> &amp; <a href="https://x">link</a>\n\n  now')).toBe("Failed & link now");
    expect(plainDetail("x".repeat(500))).toHaveLength(200);
  });
  it("nothing in, nothing out", () => {
    expect(plainDetail(undefined)).toBeUndefined();
    expect(plainDetail("<br>")).toBeUndefined();
  });
});

describe("historyText", () => {
  const at = new Date(Date.UTC(2026, 9, 5, 9, 5));
  it("says so when nothing is recorded", () => {
    expect(historyText([])).toBe("No login or logout has been recorded yet.");
  });
  it("one line per event; the detail appears only on a failure, and is escaped", () => {
    const t = historyText([
      { tool: "claude", target: "default", kind: "login", ok: true, detail: "must not show", at },
      { tool: "google", target: "a<b", kind: "remove", ok: false, detail: "x & y", at },
    ]);
    expect(t).toContain("✅ 2026-10-05 09:05 UTC — claude: signed in");
    expect(t).not.toContain("must not show");
    expect(t).toContain("❌ 2026-10-05 09:05 UTC — google a&lt;b: remove failed (x &amp; y)");
  });
});
