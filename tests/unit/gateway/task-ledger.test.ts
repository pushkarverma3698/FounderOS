/**
 * Deterministic Task Ledger — multi-step orchestration without manager tool calls.
 */

import { describe, it, expect } from "vitest";
import {
  detectTaskLedger,
  buildTaskLedgerDirective,
} from "../../../src/gateway/task-ledger.js";

describe("detectTaskLedger", () => {
  it("returns null for single-department requests", () => {
    expect(detectTaskLedger("Score Acme Corp against our ICP.")).toBeNull();
  });

  it("detects Monday brief multi-step pattern", () => {
    const ledger = detectTaskLedger(
      "monday brief pls: context memory + my open github issues + bullet plan for the week",
    );
    expect(ledger).not.toBeNull();
    expect(ledger!.map((s) => s.dept)).toEqual(["admin", "engineering", "synthesize"]);
  });

  it("detects research-then-github multi-step", () => {
    const ledger = detectTaskLedger(
      "Research langgraph js limitations then create a GitHub issue on FounderOS with findings",
    );
    expect(ledger).not.toBeNull();
    expect(ledger![0]!.dept).toBe("research");
    expect(ledger![1]!.dept).toBe("engineering");
  });

  // T29 regression: research → github issue → linkedin post fan-out used to match
  // no ledger pattern, so the supervisor improvised a multi-dept plan in one ReAct
  // loop, recursed to the limit, and skipped both HITL gates.
  it("detects research → github issue → linkedin post fan-out (T29)", () => {
    const ledger = detectTaskLedger(
      "top 3 open-source langgraph alternatives — open a github issue on pushkarverma3698/FounderOS with a summary + draft a 1-liner linkedin post. show me all before you do anything",
    );
    expect(ledger).not.toBeNull();
    expect(ledger!.map((s) => s.dept)).toEqual(["research", "engineering", "marketing"]);
  });

  // T28 regression: "draft linkedin post … gate before posting" produced an inline
  // draft and never called linkedin_post, so no approval card appeared.
  it("detects research → linkedin post fan-out (T28)", () => {
    const ledger = detectTaskLedger(
      "relevance ai vs founderos — who wins for solo founders? draft a linkedin post from that angle, gate before posting",
    );
    expect(ledger).not.toBeNull();
    expect(ledger!.map((s) => s.dept)).toEqual(["research", "marketing"]);
  });

  it("forces the linkedin_post HITL gate in the marketing step intent", () => {
    const ledger = detectTaskLedger(
      "compare us vs competitor then draft a linkedin post about it",
    )!;
    const marketing = ledger.find((s) => s.dept === "marketing")!;
    expect(marketing.intent).toMatch(/linkedin_post/);
    expect(marketing.intent).toMatch(/approval|HITL/i);
  });

  it("does NOT build a ledger for a single linkedin post with no other step", () => {
    // Single-department request stays null → normal routing (no false multi-step).
    expect(detectTaskLedger("draft a linkedin post about shipping FounderOS")).toBeNull();
  });

  it("does NOT build a ledger for a plain chained knowledge question (T35)", () => {
    // No write actions → not a fan-out; routed normally (knowledge loop handled elsewhere).
    expect(
      detectTaskLedger(
        "what does turicks do? what does naggar do? which has more revenue potential in 2026 and why?",
      ),
    ).toBeNull();
  });
});

describe("buildTaskLedgerDirective", () => {
  it("names each step and forbids supervisor tool calls", () => {
    const ledger = detectTaskLedger("monday brief pls: context memory + my open github issues + bullet plan")!;
    const directive = buildTaskLedgerDirective(ledger);
    expect(directive).toMatch(/TASK LEDGER/i);
    expect(directive).toMatch(/admin/i);
    expect(directive).toMatch(/read_context/i);
    expect(directive).toMatch(/engineering/i);
    expect(directive).toMatch(/github_read/i);
    expect(directive).toMatch(/synthesize/i);
    expect(directive).toMatch(/no business tools/i);
  });
});
