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
