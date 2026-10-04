/**
 * Capability registry tests — the manifest must always tell the truth.
 * DEPARTMENT_TOOLS is the single source for BOTH the office graph and the
 * supervisor's self-knowledge text; these tests pin that contract.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEPARTMENT_TOOLS,
  ENGINEERING_SUBAGENT_TOOLS,
  MARKETING_SUBAGENT_TOOLS,
  ADMIN_SUBAGENT_TOOLS,
  SUPERVISOR_TOOLS,
  HITL_GATED_TOOLS,
  RETRIEVAL_TOOL_TABLE,
  buildCapabilityManifest,
  buildDepartmentsSummary,
  mergeBridgedTools,
  stripBridgedTools,
} from "../../../src/agents/capabilities.js";
import { readdirSync } from "node:fs";
import * as path from "node:path";

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

  it("engineering carries vps_run and it is HITL-gated (spec 2026-07-14 item 11)", () => {
    const names = DEPARTMENT_TOOLS["engineering"]!.map((t: { name: string }) => t.name);
    expect(names).toContain("vps_run");
    expect(HITL_GATED_TOOLS.has("vps_run")).toBe(true);
  });

  it("personal carries the browser tool (the 2026-06-09 'no browser' answer was false)", () => {
    const names = DEPARTMENT_TOOLS["personal"]!.map((t: { name: string }) => t.name);
    expect(names).toContain("browser");
  });

  it("CV questions have one owner: jobhunt reads the CV, personal holds no CV reader", () => {
    // personal answered "what are my skills?" through search_personal_rag, whose
    // prod table held 4 rows last written 2026-06-15 — a June wiki stub the CV
    // code already refuses to trust (src/tools/career.ts). jobhunt's read_cv reads
    // the CV the founder maintains, and DESCRIPTIONS.jobhunt already claims every
    // CV question. A CV tool on personal as well — even read_cv — would reopen the
    // routing contest personal won on 2026-09-07, because the planner routes on
    // each worker's tool list too (tests/unit/gateway/jobhunt-department-routing).
    const personal = DEPARTMENT_TOOLS["personal"]!.map((t: { name: string }) => t.name);
    const jobhunt = DEPARTMENT_TOOLS["jobhunt"]!.map((t: { name: string }) => t.name);
    expect(jobhunt).toContain("read_cv");
    expect(personal).not.toContain("search_personal_rag");
    expect(personal).not.toContain("read_cv");
  });
});

describe("buildDepartmentsSummary (the stored founderos_departments is generated, not hand-written)", () => {
  const summary = buildDepartmentsSummary();

  it("opens with the real worker count", () => {
    expect(summary).toMatch(new RegExp(`^${Object.keys(DEPARTMENT_TOOLS).length} kernel workers`));
  });

  it("lists every department and every one of its tools, starring the gated ones", () => {
    for (const [dept, tools] of Object.entries(DEPARTMENT_TOOLS)) {
      expect(summary).toContain(`${dept} (`);
      for (const t of tools as { name: string }[]) {
        const label = HITL_GATED_TOOLS.has(t.name) ? `${t.name}*` : t.name;
        expect(summary, `${dept}/${t.name}`).toContain(label);
      }
    }
    expect(summary).toContain("send_email*");
    expect(summary).not.toMatch(/\bsend_email(?!\*)/);
  });

  it("sends 'what is running right now' to the live source instead of describing it", () => {
    expect(summary).toContain("ops_state");
    expect(summary).toContain("background_jobs");
  });

  it("does not drift when a tool is added: it is computed from the same registry as the manifest", () => {
    const fake = { name: "zz_new_tool" } as unknown as (typeof DEPARTMENT_TOOLS)["admin"][number];
    DEPARTMENT_TOOLS["admin"]!.push(fake);
    try {
      expect(buildDepartmentsSummary()).toContain("zz_new_tool");
    } finally {
      DEPARTMENT_TOOLS["admin"]!.pop();
    }
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
    // Advertises the read-only stdio server (pnpm mcp), reachable locally or
    // over SSH — so "what MCP servers do you run" answers stay truthful.
    expect(manifest).toMatch(/MCP server/);
    expect(manifest).toMatch(/pnpm mcp/);
  });

});

describe("HITL Security Invariant", () => {
  it("Reachability: every tool in HITL_GATED_TOOLS appears in at least one declared department or sub-agent registry", () => {
    const declaredNames = new Set<string>([
      ...Object.values(DEPARTMENT_TOOLS).flat().map((t: { name: string }) => t.name),
      ...Object.values(ENGINEERING_SUBAGENT_TOOLS).flat().map((t: { name: string }) => t.name),
      ...Object.values(MARKETING_SUBAGENT_TOOLS).flat().map((t: { name: string }) => t.name),
      ...Object.values(ADMIN_SUBAGENT_TOOLS).flat().map((t: { name: string }) => t.name),
    ]);

    for (const gated of HITL_GATED_TOOLS) {
      expect(declaredNames.has(gated), `HITL_GATED_TOOLS lists "${gated}" but it does not appear in any declared registry`).toBe(true);
    }
  });

  it("Coverage: every declared side-effecting tool (external send, spend, irreversible write, write outside ARTIFACT_ROOT) is HITL protected", () => {
    const declaredNames = new Set<string>([
      ...Object.values(DEPARTMENT_TOOLS).flat().map((t: { name: string }) => t.name),
      ...Object.values(ENGINEERING_SUBAGENT_TOOLS).flat().map((t: { name: string }) => t.name),
      ...Object.values(MARKETING_SUBAGENT_TOOLS).flat().map((t: { name: string }) => t.name),
      ...Object.values(ADMIN_SUBAGENT_TOOLS).flat().map((t: { name: string }) => t.name),
    ]);

    const sideEffectingTools = [
      "send_email",
      "vps_run",
      "write_file",
      "send_file",
      "deploy_static_site",
      "claude_code",
      "project_workflow",
      "run_shell",
      "linkedin_post",
      "schedule_social_post",
      "draft_linkedin_reply",
      "draft_connection_note",
      "create_calendar_event",
      "schedule_task",
      "record_event",
      "deliver_artifact",
      "browser",
      "synthesize_skill"
    ];

    for (const tool of sideEffectingTools) {
      if (declaredNames.has(tool)) {
        expect(HITL_GATED_TOOLS.has(tool), `Declared side-effecting tool '${tool}' must be in HITL_GATED_TOOLS`).toBe(true);
      }
    }
  });

  it("Enforcement: every tool listed in HITL_GATED_TOOLS has an actual hitlGate({ action: '<name>' }) enforcement point in code", () => {
    const toolsDir = fileURLToPath(new URL("../../../src/agents/agent-tools", import.meta.url));
    const extraToolsDir = fileURLToPath(new URL("../../../src/tools", import.meta.url));

    function getFiles(dir: string): string[] {
      const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith(".ts"))
        .map((e) => path.join(e.parentPath ?? dir, e.name));
    }

    const sourceFiles = [...getFiles(toolsDir), ...getFiles(extraToolsDir)];
    const sourceCode = sourceFiles.map((f) => readFileSync(f, "utf8")).join("\n");

    for (const gated of HITL_GATED_TOOLS) {
      const pattern = new RegExp(`hitlGate\\s*\\(\\s*(?:\\{[^}]*|\\n)*action:\\s*["']${gated}["']`, "m");
      expect(pattern.test(sourceCode), `Tool '${gated}' is in HITL_GATED_TOOLS but lacks a hitlGate({ action: "${gated}" }) enforcement point in source code`).toBe(true);
    }
  });

  it("imports no tool it never places in a department or sub-agent cluster", () => {
    const source = readFileSync(fileURLToPath(new URL("../../../src/agents/capabilities.ts", import.meta.url)), "utf8");
    const imported = [...source.matchAll(/^import\s*\{([^}]+)\}\s*from/gms)]
      .flatMap((m) => m[1]!.split(","))
      .map((s) => s.trim().split(/\s+as\s+/).pop()!.trim())
      .filter((s) => s.length > 0 && !s.startsWith("type "));
    const body = source.replace(/^import[\s\S]*?from\s+"[^"]+";$/gm, "");
    const orphans = imported.filter((name) => !new RegExp(`\\b${name}\\b`).test(body));
    // 2026-08-06: P7 siloed github_write out of every department and P7-B restored
    // only githubRead — but the import stayed, leaving a tool nothing could reach
    // and lint could not see (no-unused-vars does not flag it here).
    expect(orphans, `imported but never registered: ${orphans.join(", ")}`).toEqual([]);
  });

  it("the RAG placement docblock matches where each RAG table is actually read", () => {
    // The docblock claimed searchPersonalRag → personal + jobhunt and
    // searchTuricksBrain → personal + research + sales + marketing long after P7
    // (5623eff) reduced both to a single department each. A capability registry
    // whose own comment is wrong is the exact failure this file exists to prevent.
    // Since 2026-09-28 the docblock names TABLES, read through RETRIEVAL_TOOL_TABLE,
    // so a second tool over one table cannot hide behind a different tool name.
    const source = readFileSync(fileURLToPath(new URL("../../../src/agents/capabilities.ts", import.meta.url)), "utf8");
    const tables = [...new Set(Object.values(RETRIEVAL_TOOL_TABLE))].sort();
    const documented = [...source.matchAll(/^\s*\*\s*([a-z_]+)\s*→\s*(.+)$/gm)].filter(([, table]) =>
      tables.includes(table as (typeof tables)[number]),
    );
    expect(documented.map(([, table]) => table).sort(), "every RAG table has exactly one docblock line").toEqual(tables);

    for (const [, table, rhs] of documented) {
      const claimed = rhs!.trim() === "none" ? [] : rhs!.split("+").map((s) => s.trim()).sort();
      const actual = Object.entries(DEPARTMENT_TOOLS)
        .filter(([, tools]) => tools.some((t: { name: string }) => RETRIEVAL_TOOL_TABLE[t.name] === table))
        .map(([dept]) => dept)
        .sort();
      expect(claimed, `${table} docblock says "${rhs}" but the registry says "${actual.join(" + ") || "none"}"`).toEqual(actual);
    }
  });

  it("github_write stays out of the declared set unless it is also HITL-gated", () => {
    const allNames = Object.values(DEPARTMENT_TOOLS)
      .flat()
      .map((t: { name: string }) => t.name);
    // P7 (5623eff) removed it from engineering; P7-B (7d163a9) restored read only.
    // Re-adding it is a product decision, but it must not arrive ungated: the tool
    // has an inline hitlGate(), and the declared set is what renders the `*`.
    if (allNames.includes("github_write")) {
      expect(HITL_GATED_TOOLS.has("github_write"), "github_write must be declared HITL-gated").toBe(true);
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

describe("stripBridgedTools — idempotent live reload (Tier 3)", () => {
  const nativeA = { name: "send_email" };
  const nativeB = { name: "search_web" };
  const bridged1 = { name: "mcp__notion__search" };
  const bridged2 = { name: "mcp__notion__create_page" };

  it("removes only mcp__-prefixed tools and gate names, leaving native ones", () => {
    const target: Record<string, { name: string }[]> = {
      research: [nativeB, bridged1, bridged2],
      comms: [nativeA],
    };
    const hitl = new Set(["send_email", "mcp__notion__create_page"]);
    stripBridgedTools(target, hitl);
    expect(target["research"]!.map((t) => t.name)).toEqual(["search_web"]);
    expect(target["comms"]!.map((t) => t.name)).toEqual(["send_email"]);
    expect([...hitl]).toEqual(["send_email"]);
  });

  it("makes a strip→merge cycle idempotent (no duplicate tools on reload)", () => {
    const target: Record<string, { name: string }[]> = { research: [nativeB] };
    const hitl = new Set<string>();
    const byDept = { research: [bridged1, bridged2] };

    for (let i = 0; i < 3; i++) {
      stripBridgedTools(target, hitl);
      mergeBridgedTools(target, hitl, byDept, ["mcp__notion__create_page"]);
    }
    // one native + two bridged, regardless of how many reloads ran
    expect(target["research"]!.map((t) => t.name)).toEqual(["search_web", "mcp__notion__search", "mcp__notion__create_page"]);
    expect([...hitl]).toEqual(["mcp__notion__create_page"]);
  });
});
