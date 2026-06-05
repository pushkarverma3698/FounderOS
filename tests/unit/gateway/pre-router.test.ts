/**
 * Unit tests for pre-router pure functions.
 * These are stateless — no mocks, no I/O.
 */

import { describe, it, expect } from "vitest";
import { preRoutePersonalVsEngineering, isOutreachRequest } from "../../../src/gateway/pre-router.js";

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
