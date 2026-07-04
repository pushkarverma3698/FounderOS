/**
 * FounderOS — Capability Registry (single source of truth)
 * =========================================================
 * ONE place that declares which tools each department carries. Both the office
 * graph (office.ts) and the supervisor's self-knowledge text are generated
 * from this table, so "what can you do?" answers can never drift from reality
 * again (on 2026-06-09 the bot claimed it had no browser and didn't know what
 * MCP was — both false — because capability text was hand-maintained prose).
 */

import {
  searchWeb,
  scrapeUrlTool,
  deepResearch,
  crawlSiteTool,
  searchResearchCache,
  createSendEmailTool,
  readEmails,
  linkedinPost,
  linkedinGetMyPosts,
  linkedinReadComments,
  draftLinkedInReply,
  draftConnectionNote,
  createCalendarEvent,
  githubRead,
  githubWrite,
  readFile,
  listDir,
  sendFile,
  writeFile,
  runShell,
  browser,
  readCv,
  searchJobs,
  projectWorkflow,
  claudeCode,
  applyCinematicPreset,
  deployStaticSite,
  recordEvent,
  searchPersonalRag,
  searchTuricksBrain,
  publishSignal,
} from "./agent-tools.js";
import { generateImageTool, listBrandAssetsTool } from "./agent-tools/creative.js";
import { readContext, updateContext } from "../tools/context.js";
import { searchKnowledge } from "../tools/knowledge.js";
import { searchMemoryTool } from "../tools/memory.js";
import { listPendingSignals } from "./agent-tools/pending-signals.js";
import { MCP_BRIDGE_ENABLED, MCP_BRIDGE_MANIFEST } from "../core/config.js";

// Tool generics are heterogeneous across departments; the graph only needs
// `.name` + invokability, both checked by tests. Typing the union precisely
// buys nothing and fights every LangChain minor release.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = any;

/** Department → tools. office.ts builds each ReAct agent from THESE arrays.
 *
 * searchPersonalRag  → personal + jobhunt
 *   Career/CV data is needed for jobhunt (CV-to-JD semantic matching) as well as
 *   personal ("what are my skills?"). Kept off research/sales/marketing —
 *   career data is founder-private, not business-public (ADR-013/015).
 *
 * searchTuricksBrain → personal + research + sales + marketing
 *   Business knowledge (strategy, ADRs, brand, founder profile) is cross-cutting.
 *   Research needs it for context, sales for ICP/messaging, marketing for brand
 *   alignment. Engineering and comms don't query business strategy.
 */
export const DEPARTMENT_TOOLS: Record<string, AnyTool[]> = {
  admin: [readContext, updateContext, searchMemoryTool, recordEvent, listPendingSignals],
  research: [searchWeb, scrapeUrlTool, deepResearch, crawlSiteTool, searchResearchCache, searchKnowledge, searchTuricksBrain, publishSignal],
  comms: [createSendEmailTool("comms"), readEmails, createCalendarEvent],
  engineering: [githubRead, githubWrite, projectWorkflow, claudeCode, applyCinematicPreset, deployStaticSite, publishSignal],
  marketing: [searchWeb, linkedinPost, linkedinGetMyPosts, linkedinReadComments, draftLinkedInReply, draftConnectionNote, searchKnowledge, searchTuricksBrain, publishSignal],
  sales: [createSendEmailTool("sales"), searchWeb, searchKnowledge, searchTuricksBrain],
  personal: [readFile, listDir, sendFile, writeFile, runShell, browser, searchPersonalRag, searchTuricksBrain],
  jobhunt: [readCv, searchJobs, createSendEmailTool("jobhunt"), searchPersonalRag],
};

/** Engineering CTO subgraph — per-sub-agent tools (coder/qa/devops).
 *  Kept here so the capability manifest stays the single source of truth when the
 *  engineering department is promoted to a sub-supervisor (ADR-027, engineering-domain.ts). */
export const ENGINEERING_SUBAGENT_TOOLS: Record<string, AnyTool[]> = {
  coder: [claudeCode, githubRead],
  qa: [claudeCode, githubRead],
  devops: [githubWrite, projectWorkflow],
};

/** Creative sub-supervisor — per-specialist tools (art_director/copywriter/brand_designer).
 *  The Creative department is ALWAYS nested (the one department that earns it). Each
 *  specialist carries a tight 2-tool kit — over-tooling degrades an agent (roadmap). */
export const CREATIVE_SUBAGENT_TOOLS: Record<string, AnyTool[]> = {
  art_director: [generateImageTool, listBrandAssetsTool],
  copywriter: [searchTuricksBrain, searchWeb],
  brand_designer: [generateImageTool, listBrandAssetsTool],
};

/** Supervisors route via handoffs only — no business tools (ADR-028). */
export const SUPERVISOR_TOOLS: AnyTool[] = [];

/** Tools that pause for founder approval (HITL interrupt) before acting. */
export const HITL_GATED_TOOLS = new Set([
  "send_email",
  "linkedin_post",
  "draft_linkedin_reply",
  "draft_connection_note",
  "github_write",
  "write_file",
  "run_shell",
  "browser",
  "send_file",
  "claude_code",
  "deploy_static_site",
  "project_workflow",
  "create_calendar_event",
  "record_event",
]);

/**
 * Merge bridged external-MCP tools (ADR-041) into the live department registry.
 * Pure given its inputs — mutates the passed maps in place so both the office
 * graph and the capability manifest see the same tools. Gated tool names are
 * added to the HITL set so they render with `*` and the gateway knows to pause.
 */
export function mergeBridgedTools(
  target: Record<string, AnyTool[]>,
  hitl: Set<string>,
  byDept: Record<string, AnyTool[]>,
  gatedNames: string[],
): void {
  for (const name of gatedNames) hitl.add(name);
  for (const [dept, tools] of Object.entries(byDept)) {
    (target[dept] ??= []).push(...tools);
  }
}

/**
 * Connect external MCP servers and merge their tools into DEPARTMENT_TOOLS.
 * No-op unless MCP_BRIDGE_ENABLED — and the bridge modules are dynamically
 * imported so the default (flag-off) build never even loads @langchain/mcp-adapters.
 * Call once at startup, BEFORE buildOffice() reads DEPARTMENT_TOOLS.
 */
export async function applyMcpBridge(): Promise<void> {
  if (!MCP_BRIDGE_ENABLED) return;
  const { loadManifest } = await import("../mcp/bridge-manifest.js");
  const { gatedRuntimeNames } = await import("../mcp/bridge-classify.js");
  const { getBridgedTools } = await import("../mcp/client.js");

  const manifest = loadManifest(MCP_BRIDGE_MANIFEST);
  const byDept = await getBridgedTools(manifest);
  mergeBridgedTools(DEPARTMENT_TOOLS, HITL_GATED_TOOLS, byDept, gatedRuntimeNames(manifest));
}

/**
 * Render the truthful capability manifest injected into the supervisor prompt.
 * Generated from the same arrays the graph is built from — never hand-edit
 * capability claims into prompt prose.
 */
export function buildCapabilityManifest(): string {
  const lines = Object.entries(DEPARTMENT_TOOLS).map(([dept, tools]) => {
    const names = tools
      .map((t) => (HITL_GATED_TOOLS.has(t.name) ? `${t.name}*` : t.name))
      .join(", ");
    return `- ${dept}: ${names}`;
  });
  return [
    "CAPABILITIES (auto-generated from the live tool registry — this list IS the truth; never claim a listed tool is missing, never claim an unlisted tool exists; * = pauses for founder approval):",
    ...lines,
    "- supervisor (you): handoffs only — route to departments; you have NO business tools",
    "Notes:",
    "- claude_code = a full Claude Code coding agent (files, shell, git, gh) in an isolated workspace — engineering's primary executor for any build/code/repo task.",
    "- apply_cinematic_preset = copies cinematic-web preset scaffold (neon/glass/terminal/minimal) before landing page builds.",
    "- browser = deterministic low-level browser control (personal dept): open_url / get_page_text / run_js via headless Chromium (Playwright) on the VPS or Safari on macOS. Use for precise, scripted single actions.",
    "- mcp__browser-use__retry_with_browser_use_agent = the AUTONOMOUS AI browser agent (personal dept, external browser-use MCP server): give it a natural-language goal and it navigates, clicks, types, and extracts across multiple steps on its own. Use for multi-step web tasks (log in and…, find and fill…, search and summarise…). Granular mcp__browser-use__browser_navigate/click/type/scroll/extract_content/get_state tools are also available for step-by-step control.",
    "- FounderOS also RUNS an MCP server on localhost:3100 exposing search_web, read_context, search_knowledge, search_memory, read_cv, github_read to external MCP clients.",
  ].join("\n");
}
