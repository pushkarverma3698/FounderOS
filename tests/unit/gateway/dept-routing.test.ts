import { describe, expect, it } from "vitest";
import { departmentFromTransferTool } from "../../../src/gateway/dept-routing.js";

describe("departmentFromTransferTool", () => {
  it("parses transfer_to_* handoffs", () => {
    expect(departmentFromTransferTool("transfer_to_research")).toBe("research");
    expect(departmentFromTransferTool("transfer_to_marketing")).toBe("marketing");
    expect(departmentFromTransferTool("transfer_to_personal")).toBe("personal");
  });

  it("ignores non-handoff tools", () => {
    expect(departmentFromTransferTool("search_web")).toBeNull();
    expect(departmentFromTransferTool("transfer_to_unknown")).toBeNull();
  });
});
