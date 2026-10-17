import { describe, expect, it } from "vitest";
import { findButton, tapRefusal, type TapButton } from "../../../scripts/lib/tap-guard.js";

const CARD: TapButton[] = [
  { label: "Yes", data: "jh:q:2f1c6a4e-0000-4000-8000-000000000001:0" },
  { label: "No", data: "jh:q:2f1c6a4e-0000-4000-8000-000000000001:1" },
  { label: "🚀 Submit application", data: "jh:s:2f1c6a4e-0000-4000-8000-000000000001" },
  { label: "🔗 Open answer page", url: "https://node.example.ts.net/apply/x" },
];

describe("tap-guard: the live tester never presses Submit", () => {
  it("refuses the auto-apply Submit callback whatever its label says", () => {
    expect(tapRefusal({ label: "Go", data: "jh:s:2f1c6a4e-0000-4000-8000-000000000001" })).toMatch(/Submit/);
  });

  it("refuses any button labelled Submit, so a renamed callback cannot slip through", () => {
    expect(tapRefusal({ label: "✅ submit now", data: "zz:1" })).toMatch(/Submit/);
  });

  it("allows an answer option, Skip and Cancel", () => {
    expect(tapRefusal(CARD[0]!)).toBeNull();
    expect(tapRefusal({ label: "Skip", data: "jh:q:2f1c6a4e-0000-4000-8000-000000000001:skip" })).toBeNull();
    expect(tapRefusal({ label: "Cancel", data: "jh:k:2f1c6a4e-0000-4000-8000-000000000001" })).toBeNull();
  });

  it("taps only a callback that is really on that message", () => {
    expect(findButton(CARD, "jh:q:2f1c6a4e-0000-4000-8000-000000000001:1")?.label).toBe("No");
    expect(findButton(CARD, "jh:q:2f1c6a4e-0000-4000-8000-000000000001:7")).toBeUndefined();
    expect(findButton(CARD, "https://node.example.ts.net/apply/x")).toBeUndefined();
  });
});
