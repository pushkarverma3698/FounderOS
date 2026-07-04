/**
 * Regression (2026-07-04 refuse/loop audit): the loop-recovery pass composed its
 * input via buildOfficeInput, which stacked the GROUNDING DIRECTIVE ("facts MUST
 * come from tool output THIS turn") and a ROUTING DIRECTIVE ("Transfer to research
 * first") on top of the LOOP RECOVERY directive ("do NOT transfer more than once;
 * answer from what you already know"). Every branch the model could take violated
 * one directive — recovery could never converge on the T35 prompt class.
 *
 * Contract: buildRecoveryOfficeInput carries ONLY company context + the recovery
 * text. No grounding, no routing, no task ledger.
 */

import { describe, it, expect } from "vitest";
import { buildRecoveryOfficeInput, buildOfficeInput } from "../../../src/gateway/pre-router.js";
import { buildRecoveryInput } from "../../../src/gateway/loop-recovery.js";
import { isProviderNoToolUseError } from "../../../src/gateway/office-run.js";

const T35 =
  "ok so: what does turicks do? what does naggar do? which has more revenue potential in 2026 and why? and what's 1 action i should take this week for the winner?";

function joined(messages: Array<{ content: unknown }>): string {
  return messages.map((m) => String(m.content)).join("\n");
}

describe("buildRecoveryOfficeInput — no contradictory directives", () => {
  it("carries the recovery directive but no grounding/routing/ledger directives", () => {
    const msgs = buildRecoveryOfficeInput(buildRecoveryInput(T35));
    const text = joined(msgs);
    expect(text).toContain("LOOP RECOVERY");
    expect(text).not.toContain("GROUNDING DIRECTIVE");
    expect(text).not.toContain("ROUTING DIRECTIVE");
    expect(text).not.toContain("TASK LEDGER");
  });

  it("negative control: buildOfficeInput DOES inject the grounding directive for T35", () => {
    const text = joined(buildOfficeInput(T35));
    expect(text).toContain("GROUNDING DIRECTIVE");
  });

  it("preserves the founder's original ask verbatim", () => {
    const msgs = buildRecoveryOfficeInput(buildRecoveryInput(T35));
    expect(joined(msgs)).toContain(T35);
  });
});

describe("isProviderNoToolUseError", () => {
  it("matches the live OpenRouter 404 tool-use error", () => {
    expect(
      isProviderNoToolUseError(new Error("404 No endpoints found that support tool use.")),
    ).toBe(true);
  });

  it("ignores unrelated errors and non-Errors", () => {
    expect(isProviderNoToolUseError(new Error("400 API_KEY_INVALID"))).toBe(false);
    expect(isProviderNoToolUseError("404 whatever")).toBe(false);
  });
});
