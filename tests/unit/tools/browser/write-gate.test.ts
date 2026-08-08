import { describe, expect, test } from "vitest";
import { isWriteAction, isNeverAutomated } from "../../../../src/tools/browser/write-gate.js";
import type { Ref } from "../../../../src/tools/browser/types.js";

const el = (over: Partial<Ref> = {}): Ref => ({
  ref: "ref_1",
  role: "button",
  name: "Continue",
  ...over,
});

describe("isWriteAction — reads run free", () => {
  test.each([
    ["snapshot", {}],
    ["scroll", { amount: 400 }],
    ["back", {}],
    ["screenshot", {}],
    ["wait_for", { ref: "ref_3" }],
  ] as const)("%s is not a write", (action, req) => {
    expect(isWriteAction({ action, ...req } as never, undefined)).toBe(false);
  });

  test("plain navigation is not a write", () => {
    expect(isWriteAction({ action: "navigate", url: "https://github.com/pulls" }, undefined)).toBe(
      false,
    );
  });

  test("clicking an ordinary link is not a write", () => {
    expect(isWriteAction({ action: "click", ref: "ref_1" }, el({ role: "link", name: "Pull requests" }))).toBe(
      false,
    );
  });

  test("typing into an ordinary search box is not a write", () => {
    expect(
      isWriteAction({ action: "type", ref: "ref_1", text: "founderos" }, el({ role: "textbox", name: "Search" })),
    ).toBe(false);
  });
});

describe("isWriteAction — side effects are gated", () => {
  test.each([
    "Submit",
    "Send message",
    "Buy now",
    "Place order",
    "Pay $40.00",
    "Post",
    "Publish changes",
    "Delete repository",
    "Remove member",
    "Confirm and continue",
    "Save changes",
    "Apply now",
  ])("click on %s is a write", (name) => {
    expect(isWriteAction({ action: "click", ref: "ref_1" }, el({ name }))).toBe(true);
  });

  test("an element that submits a form is a write regardless of its name", () => {
    expect(isWriteAction({ action: "click", ref: "ref_1" }, el({ name: "Go", submits: true }))).toBe(true);
  });

  test("typing into a secure field is a write", () => {
    expect(
      isWriteAction({ action: "type", ref: "ref_1", text: "hunter2" }, el({ role: "textbox", name: "Password", secure: true })),
    ).toBe(true);
  });

  test("navigation carrying auth parameters is a write", () => {
    expect(
      isWriteAction({ action: "navigate", url: "https://x.com/oauth/authorize?client_id=abc&code=xyz" }, undefined),
    ).toBe(true);
  });

  test("matching is case-insensitive", () => {
    expect(isWriteAction({ action: "click", ref: "ref_1" }, el({ name: "DELETE ACCOUNT" }))).toBe(true);
  });
});

describe("isWriteAction — the gate must not be fooled by substrings", () => {
  test("'Deleted items' is a navigation label, not a delete button", () => {
    expect(isWriteAction({ action: "click", ref: "ref_1" }, el({ role: "link", name: "Deleted items" }))).toBe(
      false,
    );
  });

  test("'Post office finder' is not posting", () => {
    expect(isWriteAction({ action: "click", ref: "ref_1" }, el({ role: "link", name: "Post office finder" }))).toBe(
      false,
    );
  });

  test("'Saved searches' is not saving", () => {
    expect(isWriteAction({ action: "click", ref: "ref_1" }, el({ role: "link", name: "Saved searches" }))).toBe(
      false,
    );
  });
});

describe("isWriteAction — severity outranks the role exemption", () => {
  test("a destructive LINK is still gated even though links normally navigate", () => {
    expect(isWriteAction({ action: "click", ref: "ref_1" }, el({ role: "link", name: "Delete repository" }))).toBe(
      true,
    );
  });

  test.each(["Buy now", "Pay invoice", "Transfer funds", "Withdraw balance"])(
    "irreversible link %s is gated",
    (name) => {
      expect(isWriteAction({ action: "click", ref: "ref_1" }, el({ role: "link", name }))).toBe(true);
    },
  );

  test("a link that submits a form is gated regardless of its name", () => {
    expect(
      isWriteAction({ action: "click", ref: "ref_1" }, el({ role: "link", name: "Continue", submits: true })),
    ).toBe(true);
  });

  test("the same low-severity word on a BUTTON is gated", () => {
    expect(isWriteAction({ action: "click", ref: "ref_1" }, el({ role: "button", name: "Post" }))).toBe(true);
  });
});

describe("isWriteAction — unknown elements fail closed", () => {
  test("acting on an element we could not resolve is treated as a write", () => {
    expect(isWriteAction({ action: "click", ref: "ref_99" }, undefined)).toBe(true);
  });

  test("a disabled element is still gated rather than silently allowed", () => {
    expect(isWriteAction({ action: "click", ref: "ref_1" }, el({ name: "Submit", disabled: true }))).toBe(true);
  });
});

describe("isNeverAutomated — refused outright, not turned into a HITL card", () => {
  test("typing into a password field is never automated", () => {
    expect(isNeverAutomated({ action: "type", ref: "ref_1", text: "x" }, el({ secure: true }))).toBe(true);
  });

  test.each(["Card number", "CVV", "Security code", "Social security number", "Passport number"])(
    "typing into %s is never automated",
    (name) => {
      expect(isNeverAutomated({ action: "type", ref: "ref_1", text: "x" }, el({ role: "textbox", name }))).toBe(
        true,
      );
    },
  );

  test("solving a captcha is never automated", () => {
    expect(isNeverAutomated({ action: "click", ref: "ref_1" }, el({ name: "I'm not a robot" }))).toBe(true);
  });

  test("ordinary typing is fine", () => {
    expect(
      isNeverAutomated({ action: "type", ref: "ref_1", text: "hello" }, el({ role: "textbox", name: "Comment" })),
    ).toBe(false);
  });
});
