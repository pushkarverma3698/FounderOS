import { describe, expect, test } from "vitest";
import { normalizeSnapshot, type RawElement } from "../../../../src/tools/browser/snapshot.js";

const raw = (over: Partial<RawElement> = {}): RawElement => ({
  role: "button",
  name: "Continue",
  visible: true,
  disabled: false,
  ...over,
});

describe("normalizeSnapshot — ref assignment", () => {
  test("assigns sequential, stable refs", () => {
    const out = normalizeSnapshot([raw({ name: "A" }), raw({ name: "B" }), raw({ name: "C" })]);
    expect(out.map((r) => r.ref)).toEqual(["ref_1", "ref_2", "ref_3"]);
  });

  test("preserves document order so refs line up with the page", () => {
    const out = normalizeSnapshot([raw({ name: "First" }), raw({ name: "Second" })]);
    expect(out.map((r) => r.name)).toEqual(["First", "Second"]);
  });
});

describe("normalizeSnapshot — filtering", () => {
  test("drops invisible elements the founder could not have clicked", () => {
    const out = normalizeSnapshot([raw({ name: "Shown" }), raw({ name: "Hidden", visible: false })]);
    expect(out.map((r) => r.name)).toEqual(["Shown"]);
  });

  test("drops elements with no accessible name — an agent cannot reason about them", () => {
    const out = normalizeSnapshot([raw({ name: "" }), raw({ name: "   " }), raw({ name: "Real" })]);
    expect(out.map((r) => r.name)).toEqual(["Real"]);
  });

  test("keeps disabled elements but marks them, so the agent knows why a click failed", () => {
    const out = normalizeSnapshot([raw({ name: "Submit", disabled: true })]);
    expect(out[0]).toMatchObject({ name: "Submit", disabled: true });
  });

  test("collapses runs of whitespace in accessible names", () => {
    const out = normalizeSnapshot([raw({ name: "  Sign   in \n to GitHub " })]);
    expect(out[0]!.name).toBe("Sign in to GitHub");
  });

  test("truncates absurdly long names rather than flooding the model context", () => {
    const out = normalizeSnapshot([raw({ name: "x".repeat(500) })]);
    expect(out[0]!.name.length).toBeLessThanOrEqual(120);
  });
});

describe("normalizeSnapshot — security-relevant flags survive", () => {
  test("secure fields stay flagged", () => {
    const out = normalizeSnapshot([raw({ role: "textbox", name: "Password", secure: true })]);
    expect(out[0]!.secure).toBe(true);
  });

  test("form-submitting controls stay flagged", () => {
    const out = normalizeSnapshot([raw({ name: "Go", submits: true })]);
    expect(out[0]!.submits).toBe(true);
  });

  test("a value is carried through for form controls", () => {
    const out = normalizeSnapshot([raw({ role: "textbox", name: "Search", value: "founderos" })]);
    expect(out[0]!.value).toBe("founderos");
  });

  test("the VALUE of a secure field is never carried into the snapshot", () => {
    const out = normalizeSnapshot([raw({ role: "textbox", name: "Password", secure: true, value: "hunter2" })]);
    expect(out[0]!.value).toBeUndefined();
  });
});

describe("normalizeSnapshot — bounded output", () => {
  test("caps the element count so a pathological page cannot blow the context", () => {
    const many = Array.from({ length: 500 }, (_, i) => raw({ name: `Item ${i}` }));
    const out = normalizeSnapshot(many);
    expect(out.length).toBeLessThanOrEqual(200);
  });

  test("an empty page yields an empty snapshot rather than throwing", () => {
    expect(normalizeSnapshot([])).toEqual([]);
  });
});
