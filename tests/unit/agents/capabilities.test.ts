/**
 * Capability registry tests — the manifest must always tell the truth.
 * DEPARTMENT_TOOLS is the single source for BOTH the office graph and the
 * supervisor's self-knowledge text; these tests pin that contract.
 */

import { describe, it, expect } from "vitest";
import {
  DEPARTMENT_TOOLS,
  SUPERVISOR_TOOLS,
  HITL_GATED_TOOLS,
  buildCapabilityManifest,
} from "../../../src/agents/capabilities.js";

describe("DEPARTMENT_TOOLS registry", () => {
  it("declares all 8 departments (admin worker + 7 operational)", () => {
    expect(Object.keys(DEPARTMENT_TOOLS).sort()).toEqual(
      ["admin", "comms", "engineering", "jobhunt", "marketing", "personal", "research", "sales"].sort(),
    );
  });

  it("every entry is a named tool", () => {
    for (const [dept, tools] of Object.entries(DEPARTMENT_TOOLS)) {
      expect(tools.length, `${dept} has tools`).toBeGreaterThan(0);
      for (const t of tools) {
        expect(typeof (t as { name: unknown }).name, `${dept} tool has a name`).toBe("string");
      }
    }
  });

  it("engineering carries claude_code (the primary executor)", () => {
    const names = DEPARTMENT_TOOLS["engineering"]!.map((t: { name: string }) => t.name);
    expect(names).toContain("claude_code");
  });

  it("personal carries the browser tool (the 2026-06-09 'no browser' answer was false)", () => {
    const names = DEPARTMENT_TOOLS["personal"]!.map((t: { name: string }) => t.name);
    expect(names).toContain("browser");
  });
});

describe("buildCapabilityManifest", () => {
  const manifest = buildCapabilityManifest();

  it("lists every department with its real tool names", () => {
    for (const [dept, tools] of Object.entries(DEPARTMENT_TOOLS)) {
      expect(manifest).toContain(`- ${dept}:`);
      for (const t of tools) {
        expect(manifest, `${dept}/${(t as { name: string }).name} in manifest`).toContain((t as { name: string }).name);
      }
    }
  });

  it("marks HITL-gated tools with an asterisk", () => {
    expect(manifest).toContain("claude_code*");
    expect(manifest).toContain("github_write*");
    expect(manifest).toContain("send_email*");
  });

  it("lists admin department tools (moved from supervisor per ADR-028)", () => {
    const adminNames = DEPARTMENT_TOOLS["admin"]!.map((t: { name: string }) => t.name);
    expect(adminNames).toContain("read_context");
    expect(adminNames).toContain("search_memory");
    expect(adminNames).toContain("list_pending_signals");
    for (const name of adminNames) {
      expect(manifest).toContain(name);
    }
  });

  it("supervisor is handoffs-only (no business tools in SUPERVISOR_TOOLS)", () => {
    expect(SUPERVISOR_TOOLS).toEqual([]);
    expect(manifest).toMatch(/supervisor.*handoffs only/i);
  });

  it("mentions the MCP server so 'what MCP servers' answers are truthful", () => {
    expect(manifest).toMatch(/MCP server on localhost:3100/);
  });

  it("HITL set covers every side-effecting tool name present in departments", () => {
    const allNames = Object.values(DEPARTMENT_TOOLS).flat().map((t: { name: string }) => t.name);
    for (const gated of HITL_GATED_TOOLS) {
      expect(allNames, `${gated} exists in a department`).toContain(gated);
    }
  });

  it("marketing can LIST scheduled posts — 2026-07-11 turn 1fb2ea76 had no route to answer", () => {
    const marketing = DEPARTMENT_TOOLS["marketing"]!.map((t: { name: string }) => t.name);
    expect(marketing).toContain("list_scheduled_posts");
    // Read access only: creating/scheduling posts stays a comms concern (HITL-gated there).
    expect(marketing).not.toContain("schedule_social_post");
    const comms = DEPARTMENT_TOOLS["comms"]!.map((t: { name: string }) => t.name);
    expect(comms).toContain("list_scheduled_posts");
  });
});

describe("SUPERVISOR_PROMPT embeds the generated manifest", () => {
  it("contains the auto-generated capability header", async () => {
    const { SUPERVISOR_PROMPT } = await import("../../../src/agents/system-prompts.js");
    expect(SUPERVISOR_PROMPT).toContain("CAPABILITIES (auto-generated from the live tool registry");
    expect(SUPERVISOR_PROMPT).toContain("claude_code*");
  });
});
