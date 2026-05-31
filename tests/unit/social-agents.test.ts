/**
 * RED tests for social department agents and senior_engineer.
 * Write before registry changes — watch these fail first, then implement.
 */

import { describe, it, expect } from "vitest";
import { getAgent } from "../../src/core/registry.js";

describe("social_linkedin agent", () => {
  it("exists in registry", () => {
    const agent = getAgent("social_linkedin");
    expect(agent).toBeDefined();
  });

  it("belongs to social department", () => {
    const agent = getAgent("social_linkedin");
    expect(agent.department).toBe("social");
  });

  it("has composio linkedin tools", () => {
    const agent = getAgent("social_linkedin");
    expect(agent.allowed_tools).toContain("composio_linkedin_post");
    expect(agent.allowed_tools).toContain("composio_linkedin_reply");
  });

  it("uses md cascade tier for content quality", () => {
    const agent = getAgent("social_linkedin");
    expect(agent.cascade_tier).toBe("md");
  });
});

describe("social_instagram agent", () => {
  it("exists in registry", () => {
    const agent = getAgent("social_instagram");
    expect(agent).toBeDefined();
  });

  it("belongs to social department", () => {
    const agent = getAgent("social_instagram");
    expect(agent.department).toBe("social");
  });

  it("defaults to nano tier (token economy rule)", () => {
    const agent = getAgent("social_instagram");
    expect(agent.cascade_tier).toBe("nano");
  });

  it("has composio instagram tool", () => {
    const agent = getAgent("social_instagram");
    expect(agent.allowed_tools).toContain("composio_instagram_post");
  });
});

describe("senior_engineer agent", () => {
  it("exists in registry", () => {
    const agent = getAgent("senior_engineer");
    expect(agent).toBeDefined();
  });

  it("belongs to engineering department", () => {
    const agent = getAgent("senior_engineer");
    expect(agent.department).toBe("engineering");
  });

  it("has github_create_pr tool for autonomous PR creation", () => {
    const agent = getAgent("senior_engineer");
    expect(agent.allowed_tools).toContain("github_create_pr");
  });

  it("has github_push_files and github_read tools", () => {
    const agent = getAgent("senior_engineer");
    expect(agent.allowed_tools).toContain("github_push_files");
    expect(agent.allowed_tools).toContain("github_read");
  });

  it("uses ceo tier for architectural reasoning", () => {
    const agent = getAgent("senior_engineer");
    expect(agent.cascade_tier).toBe("ceo");
  });

  it("is assigned to turicks company", () => {
    const agent = getAgent("senior_engineer");
    expect(agent.company_assignment).toBe("turicks");
  });
});
