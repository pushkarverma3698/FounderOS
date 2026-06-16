/**
 * Unit tests for pre-router pure functions.
 * These are stateless — no mocks, no I/O.
 */

import { describe, it, expect } from "vitest";
import {
  preRoutePersonalVsEngineering,
  isOutreachRequest,
  preRouteDepartment,
  buildOfficeInput,
} from "../../../src/gateway/pre-router.js";
import { SystemMessage } from "@langchain/core/messages";
import { GOLDEN_TASKS } from "../../../src/eval/golden-tasks.js";

// ── preRoutePersonalVsEngineering ─────────────────────────────────────────────

describe("preRoutePersonalVsEngineering", () => {
  it("routes ~/Desktop path to personal", () => {
    expect(preRoutePersonalVsEngineering("Read ~/Desktop/file.txt")).toBe("personal");
  });

  it("routes /Users/pushkarverma path to personal", () => {
    expect(preRoutePersonalVsEngineering("Show me /Users/pushkarverma/Projects/notes.md")).toBe("personal");
  });

  it("routes desktop keyword to personal", () => {
    expect(preRoutePersonalVsEngineering("What files are on my desktop?")).toBe("personal");
  });

  it("routes downloads folder to personal", () => {
    expect(preRoutePersonalVsEngineering("List my downloads folder")).toBe("personal");
  });

  it("routes documents folder to personal", () => {
    expect(preRoutePersonalVsEngineering("Open the documents folder")).toBe("personal");
  });

  it("routes home folder to personal", () => {
    expect(preRoutePersonalVsEngineering("Show my home folder")).toBe("personal");
  });

  it("routes git status in ~/Projects to personal (local path beats github)", () => {
    expect(preRoutePersonalVsEngineering("Run git status in ~/Projects/founderos")).toBe("personal");
  });

  it("routes GitHub repo list request to engineering", () => {
    expect(preRoutePersonalVsEngineering("List my GitHub repos")).toBe("engineering");
  });

  it("routes GitHub issue creation to engineering", () => {
    expect(preRoutePersonalVsEngineering("Create a GitHub issue on my repo")).toBe("engineering");
  });

  it("routes GitHub repository keyword to engineering", () => {
    expect(preRoutePersonalVsEngineering("Clone the repository")).toBe("engineering");
  });

  it("returns null for a generic TypeScript question", () => {
    expect(preRoutePersonalVsEngineering("Write a TypeScript function to validate emails")).toBeNull();
  });

  it("returns null for a research task", () => {
    expect(preRoutePersonalVsEngineering("Research what Stripe does")).toBeNull();
  });

  it("returns null for a sales outreach request", () => {
    expect(preRoutePersonalVsEngineering("Draft cold outreach to the founder of Acme")).toBeNull();
  });
});

// ── isOutreachRequest ─────────────────────────────────────────────────────────

describe("isOutreachRequest", () => {
  it("detects 'outreach' keyword", () => {
    expect(isOutreachRequest("Draft cold outreach to the founder of Acme")).toBe(true);
  });

  it("detects 'cold email' phrase", () => {
    expect(isOutreachRequest("Write a cold email to the CTO of Beta Ltd")).toBe(true);
  });

  it("detects 'reach out' phrase", () => {
    expect(isOutreachRequest("Please reach out to alex@acme.com")).toBe(true);
  });

  it("returns false for a research task", () => {
    expect(isOutreachRequest("Research what Stripe does")).toBe(false);
  });

  it("returns false for a generic email read", () => {
    expect(isOutreachRequest("Check my unread emails")).toBe(false);
  });

  it("returns false for LinkedIn post request", () => {
    expect(isOutreachRequest("Draft a LinkedIn post about AI agents")).toBe(false);
  });
});

// ── preRouteDepartment (all 7 departments) ────────────────────────────────────

describe("preRouteDepartment", () => {
  it("returns null for empty / whitespace input", () => {
    expect(preRouteDepartment("")).toBeNull();
    expect(preRouteDepartment("   ")).toBeNull();
  });

  // ── Explicit "[Route directly to X department]" prefix (highest precedence) ──
  it("honours an explicit research routing prefix", () => {
    expect(preRouteDepartment("[Route directly to research department]: What does Anthropic do?")).toBe("research");
  });

  it("honours an explicit personal routing prefix", () => {
    expect(preRouteDepartment("[Route directly to personal department]: List files on my Desktop")).toBe("personal");
  });

  it("ignores a prefix that names a non-existent department", () => {
    // 'wizardry' is not routable → falls through to keyword rules ('files'/'desktop' → personal here)
    expect(preRouteDepartment("[Route directly to wizardry department]: do magic")).not.toBe("wizardry" as never);
  });

  // ── Disambiguation cases (the rules that prevent the most common mistakes) ──
  it("routes a code request with 'email address' to engineering, NOT comms", () => {
    expect(preRouteDepartment("Write a TypeScript function that validates an email address.")).toBe("engineering");
  });

  it("routes a job 'outreach email' to jobhunt, NOT sales", () => {
    expect(
      preRouteDepartment("Find open AI engineer positions at companies using LangGraph and draft a tailored outreach email to the best fit."),
    ).toBe("jobhunt");
  });

  it("routes a GitHub issue mentioning 'job-hunt' to engineering, NOT jobhunt", () => {
    expect(
      preRouteDepartment("Create a GitHub issue titled 'feat: add job-hunt golden eval tasks'"),
    ).toBe("engineering");
  });

  it("routes a LinkedIn post that says 'build' to marketing, NOT engineering", () => {
    expect(preRouteDepartment("Write a LinkedIn post about how we build AI apps")).toBe("marketing");
  });

  it("routes 'git status in ~/Projects on my Mac' to personal, NOT engineering", () => {
    expect(preRouteDepartment("Run `git status` in my ~/Projects/founderos folder on my Mac.")).toBe("personal");
  });

  it("routes cold outreach to sales", () => {
    expect(preRouteDepartment("Draft cold outreach to the founder of Acme")).toBe("sales");
  });

  it("routes a known-contact email to comms", () => {
    expect(preRouteDepartment("Email our client alex@acme.com a thank-you note")).toBe("comms");
  });

  it("routes ICP scoring to research", () => {
    expect(preRouteDepartment("Score Acme Corp as a Turicks prospect against our ICP.")).toBe("research");
  });

  it("routes terminal shell commands to personal", () => {
    expect(preRouteDepartment('run this in terminal: echo "FounderOS E2E test"')).toBe("personal");
  });

  it("defers multi-department monday brief orchestration to the supervisor", () => {
    expect(
      preRouteDepartment("monday brief pls: context memory + my open github issues + bullet plan"),
    ).toBeNull();
  });

  it("defers research-then-github multi-step to the supervisor", () => {
    expect(
      preRouteDepartment(
        "Research langgraph js limitations then create a GitHub issue on FounderOS with findings",
      ),
    ).toBeNull();
  });

  // ── Invariant: the pre-router is NEVER wrong on the golden set ──────────────
  // It may return null (defer to the supervisor) but must never fire a department
  // that differs from the golden task's expected route.
  it("never routes a golden task to the WRONG department", () => {
    for (const task of GOLDEN_TASKS) {
      const got = preRouteDepartment(task.input);
      if (got !== null) {
        expect(got, `task "${task.id}" misrouted`).toBe(task.expectedRoute);
      }
    }
  });

  // ── Coverage: the router actually does work (doesn't just defer everything) ──
  it("resolves a concrete department for the overwhelming majority of golden tasks", () => {
    const resolved = GOLDEN_TASKS.filter((t) => preRouteDepartment(t.input) !== null);
    // All 29 golden tasks currently resolve; assert a high floor so a regression
    // that silently turns the router into a no-op fails loudly.
    expect(resolved.length).toBeGreaterThanOrEqual(GOLDEN_TASKS.length - 2);
  });
});

// ── buildOfficeInput ──────────────────────────────────────────────────────────

describe("buildOfficeInput", () => {
  it("prepends a SystemMessage hint when a department is matched", () => {
    const msgs = buildOfficeInput("List my GitHub repositories.");
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toBeInstanceOf(SystemMessage);
    expect(String(msgs[0]!.content)).toContain("engineering");
    expect(String(msgs[1]!.content)).toBe("List my GitHub repositories.");
  });

  it("returns only the HumanMessage when no rule matches", () => {
    // A vague greeting matches nothing → no hint, supervisor decides.
    const msgs = buildOfficeInput("hey there");
    expect(msgs).toHaveLength(1);
    expect(String(msgs[0]!.content)).toBe("hey there");
  });

  it("the hint keeps a multi-step escape hatch (LLM may sequence across depts)", () => {
    const msgs = buildOfficeInput("Research what Stripe does");
    expect(String(msgs[0]!.content)).toMatch(/multi-step request that clearly spans/i);
  });
});
