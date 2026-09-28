/**
 * "🧭 Everything I can do" — the founder's view of the live tool registry.
 *
 * The founder, 2026-09-28: "make sure that all the features and commands are
 * already there so that we can see all the capabilities we already have".
 * buildCapabilityManifest() already rendered the truth from DEPARTMENT_TOOLS,
 * but only into the supervisor's prompt; he never saw it. This screen renders
 * the same registry for him, with each tool's OWN description — no capability
 * claim is written by hand (capabilities.ts: "never hand-edit capability
 * claims"), so a tool added to a department appears here without anyone
 * remembering to add it.
 */

import { describe, it, expect, vi } from "vitest";
import type { Context } from "grammy";
import { DEPARTMENT_TOOLS, HITL_GATED_TOOLS } from "../../../src/agents/capabilities.js";
import { WORKERS } from "../../../src/kernel/contracts.js";
import {
  DEPARTMENT_LABELS,
  firstSentence,
  renderCapabilities,
  sendCapabilities,
  toolLabel,
  type CapabilityRegistry,
} from "../../../src/gateway/capabilities-screen.js";
import { TELEGRAM_MAX_CHARS } from "../../../src/tools/jobhunt/telegram-format.js";

type Tool = { name: string; description?: string };

const live: CapabilityRegistry = {
  departments: DEPARTMENT_TOOLS as Record<string, Tool[]>,
  gated: HITL_GATED_TOOLS,
  isAvailable: () => true,
};

/** Rows of one department, as rendered: every line under its heading until the next heading. */
function rowsOf(parts: string[], label: string): string[] {
  const lines = parts.join("\n").split("\n");
  const start = lines.findIndex((l) => l.includes(`<b>${label}</b>`));
  if (start === -1) return [];
  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("• ")) break;
    rows.push(line);
  }
  return rows;
}

describe("renderCapabilities — the live registry, for the founder", () => {
  const parts = renderCapabilities(live);
  const all = parts.join("\n");

  it("lists every department, jobhunt included, and every tool each one carries", () => {
    for (const [dept, tools] of Object.entries(DEPARTMENT_TOOLS as Record<string, Tool[]>)) {
      const label = DEPARTMENT_LABELS[dept as keyof typeof DEPARTMENT_LABELS]?.label ?? dept;
      const rows = rowsOf(parts, label);
      expect(rows.length, dept).toBe(tools.length);
      for (const tool of tools) {
        expect(rows.some((r) => r.includes(`<b>${toolLabel(tool.name)}</b>`)), `${dept}/${tool.name}`).toBe(true);
      }
    }
    expect(all).toContain("<b>Jobs</b>");
  });

  it("marks exactly the approval-gated tools as asking first", () => {
    for (const [dept, tools] of Object.entries(DEPARTMENT_TOOLS as Record<string, Tool[]>)) {
      const label = DEPARTMENT_LABELS[dept as keyof typeof DEPARTMENT_LABELS]?.label ?? dept;
      for (const row of rowsOf(parts, label)) {
        const tool = tools.find((t) => row.includes(`<b>${toolLabel(t.name)}</b>`))!;
        expect(row.includes("asks first"), `${dept}/${tool.name}`).toBe(HITL_GATED_TOOLS.has(tool.name));
      }
    }
  });

  it("uses each tool's own description", () => {
    const sendEmail = (DEPARTMENT_TOOLS["comms"] as Tool[]).find((t) => t.name === "send_email")!;
    expect(all).toContain(firstSentence(sendEmail.description ?? ""));
  });

  it("never leaves a snake_case id as the only label", () => {
    for (const [, tools] of Object.entries(DEPARTMENT_TOOLS as Record<string, Tool[]>)) {
      for (const tool of tools) expect(toolLabel(tool.name)).not.toMatch(/_/);
    }
  });

  it("keeps every message inside Telegram's cap", () => {
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) expect(part.length).toBeLessThan(TELEGRAM_MAX_CHARS);
  });
});

describe("renderCapabilities — what the registry can contain", () => {
  it("shows a bridged MCP tool under its department, server named, gate honoured", () => {
    const parts = renderCapabilities({
      departments: { engineering: [{ name: "mcp__slack__post_message", description: "Post a message to a Slack channel. More text." }] },
      gated: new Set(["mcp__slack__post_message"]),
      isAvailable: () => true,
    });
    expect(parts.join("\n")).toMatch(/<b>Slack: post message<\/b> — Post a message to a Slack channel\. .*asks first/);
  });

  it("says when the server has not set a tool up, instead of claiming it", () => {
    const parts = renderCapabilities({
      departments: { engineering: [{ name: "vps_run", description: "Run one command in a sandbox." }] },
      gated: new Set(["vps_run"]),
      isAvailable: (name) => name !== "vps_run",
    });
    expect(parts.join("\n")).toMatch(/VPS run.*not set up on this server/);
  });

  it("splits an oversized department across messages and drops no row", () => {
    const tools = Array.from({ length: 200 }, (_, i) => ({
      name: `tool_number_${i}`,
      description: `Does the specific thing number ${i} for the founder, reliably and on time. More detail.`,
    }));
    const parts = renderCapabilities({ departments: { research: tools }, gated: new Set(), isAvailable: () => true });
    expect(parts.length).toBeGreaterThan(2);
    for (const part of parts) expect(part.length).toBeLessThan(TELEGRAM_MAX_CHARS);
    const all = parts.join("\n");
    for (let i = 0; i < 200; i += 1) expect(all).toContain(`thing number ${i} for`);
    expect(all).toContain("(continued)");
  });
});

describe("firstSentence / toolLabel", () => {
  it("stops at the first sentence, not at an abbreviation", () => {
    expect(firstSentence("List unconsumed signals (e.g. qualified leads). Read-only.")).toBe(
      "List unconsumed signals (e.g. qualified leads).",
    );
    expect(firstSentence("Read the journal (founderos.service). Second.")).toBe("Read the journal (founderos.service).");
    expect(firstSentence("No full stop at all")).toBe("No full stop at all");
    expect(firstSentence("")).toBe("");
  });

  it("caps a very long first sentence rather than dropping it", () => {
    const long = firstSentence(`${"word ".repeat(80)}end.`);
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith("…")).toBe(true);
  });

  it("turns tool ids into words", () => {
    expect(toolLabel("send_email")).toBe("Send email");
    expect(toolLabel("read_cv")).toBe("Read CV");
    expect(toolLabel("linkedin_get_my_posts")).toBe("LinkedIn get my posts");
    expect(toolLabel("mcp__github__create_issue")).toBe("GitHub: create issue");
  });
});

describe("DEPARTMENT_LABELS", () => {
  it("names every kernel worker", () => {
    for (const w of WORKERS) expect(DEPARTMENT_LABELS[w].label.length).toBeGreaterThan(0);
  });
});

describe("sendCapabilities", () => {
  it("sends every part and puts the menu keyboard on the last one", async () => {
    const sent: Array<{ text: string; markup?: unknown }> = [];
    const ctx = {
      reply: vi.fn(async (text: string, opts?: { reply_markup?: unknown }) => void sent.push({ text, markup: opts?.reply_markup })),
    } as unknown as Context;
    const keyboard = { inline_keyboard: [] };
    await sendCapabilities(ctx, keyboard, async () => live);
    expect(sent.length).toBe(renderCapabilities(live).length);
    expect(sent.at(-1)?.markup).toBe(keyboard);
    expect(sent.slice(0, -1).every((s) => s.markup === undefined)).toBe(true);
  });

  it("answers loudly when the registry cannot be loaded", async () => {
    const sent: string[] = [];
    const ctx = { reply: vi.fn(async (text: string) => void sent.push(text)) } as unknown as Context;
    await sendCapabilities(ctx, { inline_keyboard: [] }, async () => {
      throw new Error("module failed");
    });
    expect(sent.join("\n")).toMatch(/couldn't load/i);
    expect(sent.join("\n")).toContain("module failed");
  });
});
