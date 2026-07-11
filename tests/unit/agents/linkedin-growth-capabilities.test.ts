/**
 * Marketing capability registry — LinkedIn growth tools must be wired.
 */

import { describe, it, expect } from "vitest";
import { DEPARTMENT_TOOLS } from "../../../src/agents/capabilities.js";

describe("marketing LinkedIn growth capabilities", () => {
  const names = DEPARTMENT_TOOLS["marketing"]!.map((t: { name: string }) => t.name);

  it("includes linkedin_analytics for learn-before-draft loop", () => {
    expect(names).toContain("linkedin_analytics");
  });

  it("includes linkedin_get_my_posts as analytics prerequisite", () => {
    expect(names).toContain("linkedin_get_my_posts");
  });

  it("linkedin_post remains the HITL-gated publish path", () => {
    expect(names).toContain("linkedin_post");
  });
});
