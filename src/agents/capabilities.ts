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
  linkedinAnalytics,
  linkedinReadComments,
  draftLinkedInReply,
  draftConnectionNote,
  scheduleSocialPost,
  listScheduledPosts,
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
  scanAiVisibility,
  getGapScans,
} from "./agent-tools.js";
import { generateImageTool, listBrandAssetsTool } from "./agent-tools/creative.js";
import { scheduleTask, listScheduled, editScheduled } from "./agent-tools/scheduling.js";
import { readContext, updateContext } from "../tools/context.js";
import { searchKnowledge } from "../tools/knowledge.js";
import { searchMemoryTool } from "../tools/memory.js";
import { writeArtifact } from "../tools/artifact.js";
import { listPendingSignals } from "./agent-tools/pending-signals.js";
import { MCP_BRIDGE_ENABLED, MCP_BRIDGE_MANIFEST } from "../core/config.js";
import type { BridgeManifest } from "../mcp/bridge-manifest.js";
import type { BridgedTools } from "../mcp/client.js";

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
  admin: [readContext, updateContext, searchMemoryTool, recordEvent, listPendingSignals, scheduleTask, listScheduled, editScheduled, writeArtifact],
  research: [searchWeb, scrapeUrlTool, deepResearch, crawlSiteTool, searchResearchCache, searchKnowledge, searchTuricksBrain, publishSignal, scanAiVisibility, getGapScans],
  comms: [createSendEmailTool("comms"), readEmails, createCalendarEvent, scheduleSocialPost, listScheduledPosts],
  engineering: [githubRead, githubWrite, projectWorkflow, claudeCode, applyCinematicPreset, deployStaticSite, publishSignal],
  marketing: [searchWeb, linkedinPost, linkedinGetMyPosts, linkedinAnalytics, linkedinReadComments, draftLinkedInReply, draftConnectionNote, searchKnowledge, searchTuricksBrain, publishSignal, generateImageTool, listBrandAssetsTool, listScheduledPosts],
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

/** Supervisors route via handoffs only — no business tools (ADR-028). */
export const SUPERVISOR_TOOLS: AnyTool[] = [];

/** Tools that pause for founder approval (HITL interrupt) before acting. */
export const HITL_GATED_TOOLS = new Set([
  "send_email",
  "linkedin_post",
  "schedule_social_post",
  "schedule_task",
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
 * Drop every previously-merged bridged tool (all `mcp__`-prefixed) from the
 * registry and HITL set. Native tools never carry that prefix, so this makes
 * applyMcpBridge idempotent — safe to re-run on a live `/connect` reload without
 * duplicating a server's tools.
 */
export function stripBridgedTools(
  target: Record<string, AnyTool[]> = DEPARTMENT_TOOLS,
  hitl: Set<string> = HITL_GATED_TOOLS,
): void {
  for (const dept of Object.keys(target)) {
    target[dept] = (target[dept] ?? []).filter((t) => !String(t.name).startsWith("mcp__"));
  }
  for (const name of [...hitl]) if (name.startsWith("mcp__")) hitl.delete(name);
}

/** Injectable seams for applyMcpBridge (same discipline as buildBridgedTools'
 *  client factory): production omits them and gets the real dynamically
 *  imported modules; tests pass fakes so no adapter loads and no process spawns. */
interface McpBridgeDeps {
  loadManifest: (path: string) => BridgeManifest;
  getBridgedTools: (manifest: BridgeManifest) => Promise<BridgedTools>;
}

/**
 * Connect external MCP servers and merge their tools into DEPARTMENT_TOOLS.
 * No-op unless MCP_BRIDGE_ENABLED — and the bridge modules are dynamically
 * imported so the default (flag-off) build never even loads @langchain/mcp-adapters.
 * Idempotent: previously-bridged tools are stripped in the SAME synchronous
 * block as the merge (no await between), so overlapping invocations (startup
 * racing a /connect reload) can never interleave strip/merge and duplicate
 * tools, and in-flight turns keep seeing the previous bridge tools until the
 * new set lands.
 */
export async function applyMcpBridge(deps?: McpBridgeDeps): Promise<void> {
  if (!deps && !MCP_BRIDGE_ENABLED) return;
  const { loadManifest } = deps ?? (await import("../mcp/bridge-manifest.js"));
  const { getBridgedTools } = deps ?? (await import("../mcp/client.js"));

  const manifest = loadManifest(MCP_BRIDGE_MANIFEST);
  // gatedNames comes from the LOADED tools (manifest write list OR annotation),
  // so annotation-gated tools render with `*` and no dead gates leak in.
  const { byDept, gatedNames } = await getBridgedTools(manifest);
  stripBridgedTools();
  mergeBridgedTools(DEPARTMENT_TOOLS, HITL_GATED_TOOLS, byDept, gatedNames);
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
    "- browser = Safari automation on the founder's Mac (personal dept).",
    "- FounderOS also RUNS an MCP server on localhost:3100 exposing search_web, read_context, search_knowledge, search_memory, read_cv, github_read to external MCP clients.",
  ].join("\n");
}
