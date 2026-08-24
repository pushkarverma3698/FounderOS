/**
 * FounderOS — Capability Registry (single source of truth)
 * =========================================================
 * ONE place that declares which tools each department carries. Both the kernel's
 * worker specs (buildWorkerSpecs in gateway/kernel-boot.ts) and the supervisor's
 * self-knowledge text are generated from this table, so "what can you do?"
 * answers can never drift from reality again (on 2026-06-09 the bot claimed it
 * had no browser and didn't know what MCP was — both false — because capability
 * text was hand-maintained prose).
 */

import {
  searchWeb,
  scrapeUrlTool,
  deepResearch,
  crawlSiteTool,
  youtubeTranscript,
  v2exTopics,
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
  readFile,
  listDir,
  sendFile,
  writeFile,
  runShell,
  browser,
  readCv,
  searchJobs,
  ingestJobs,
  screenJob,
  reviewScreened,
  cvGaps,
  jobBrief,
  tailorCvForRow,
  submitApplication,
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
  vpsRun,
  jobState,
  opsState,
  writeArtifact,
  deliverArtifact,
} from "./agent-tools.js";
import { generateImageTool, listBrandAssetsTool } from "./agent-tools/creative.js";
import {
  listVideoBrandsTool,
  compileVideoBriefTool,
  compileShotListTool,
  planVideoProductionTool,
  videoProductionStatusTool,
} from "./agent-tools/video.js";
import { scheduleTask, listScheduled, editScheduled } from "./agent-tools/scheduling.js";
import { setReminder, listReminders, editReminder } from "./agent-tools/reminders.js";
import { listWorkflows } from "./agent-tools/workflows.js";
import { readContext, updateContext } from "../tools/context.js";
import { searchKnowledge } from "../tools/knowledge.js";
import { searchMemoryTool } from "../tools/memory.js";
import { listPendingSignals } from "./agent-tools/pending-signals.js";
import { MCP_BRIDGE_ENABLED, MCP_BRIDGE_MANIFEST } from "../core/config.js";
import type { BridgeManifest } from "../mcp/bridge-manifest.js";
import type { BridgedTools } from "../mcp/client.js";

// Tool generics are heterogeneous across departments; the graph only needs
// `.name` + invokability, both checked by tests. Typing the union precisely
// buys nothing and fights every LangChain minor release.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = any;

/** Department → tools. buildWorkerSpecs() builds each kernel worker from THESE
 * arrays (minus anything isUnconfiguredTool withholds).
 *
 * RAG placement, as P7 (5623eff) left it — one retrieval surface per corpus, so
 * two workers can never answer the same question from different indexes:
 *
 * searchPersonalRag  → personal
 *   Career/CV data is founder-private, not business-public (ADR-013/015).
 *   jobhunt used to carry it too; P7 removed that overlap — jobhunt reads the CV
 *   through readCv/cvGaps, which is the path its prompts actually name.
 *
 * searchTuricksBrain → research
 *   Business knowledge (strategy, ADRs, brand, founder profile). P7 narrowed this
 *   from personal+research+sales+marketing to research alone; sales and marketing
 *   keep searchKnowledge for the same material.
 */
import { synthesizeSkill } from "./agent-tools.js";

export const DEPARTMENT_TOOLS: Record<string, AnyTool[]> = {
  admin: [readContext, updateContext, searchMemoryTool, recordEvent, listPendingSignals, scheduleTask, listScheduled, editScheduled, setReminder, listReminders, editReminder, listWorkflows, synthesizeSkill, opsState, writeArtifact, deliverArtifact],
  research: [searchWeb, scrapeUrlTool, deepResearch, crawlSiteTool, youtubeTranscript, v2exTopics, searchResearchCache, searchKnowledge, searchTuricksBrain, publishSignal, scanAiVisibility, getGapScans],
  comms: [createSendEmailTool("comms"), readEmails, createCalendarEvent, scheduleSocialPost, listScheduledPosts],
  engineering: [projectWorkflow, claudeCode, applyCinematicPreset, deployStaticSite, vpsRun, synthesizeSkill, githubRead],
  marketing: [linkedinPost, linkedinGetMyPosts, linkedinAnalytics, linkedinReadComments, draftLinkedInReply, draftConnectionNote, generateImageTool, listBrandAssetsTool, listVideoBrandsTool, compileVideoBriefTool, compileShotListTool, planVideoProductionTool, videoProductionStatusTool, listScheduledPosts, searchWeb, searchKnowledge, publishSignal],
  sales: [searchWeb, createSendEmailTool("sales"), searchKnowledge],
  personal: [readFile, listDir, runShell, browser, searchPersonalRag, sendFile, writeFile],
  jobhunt: [readCv, searchJobs, ingestJobs, screenJob, reviewScreened, cvGaps, jobState, tailorCvForRow, writeArtifact, deliverArtifact, jobBrief, submitApplication, createSendEmailTool("jobhunt")],
};

/** Engineering CTO subgraph — per-sub-agent tools (coder/qa/devops). */
export const ENGINEERING_SUBAGENT_TOOLS: Record<string, AnyTool[]> = {
  coder: [claudeCode, githubRead, synthesizeSkill],
  qa: [claudeCode, githubRead],
  devops: [claudeCode, projectWorkflow],
};

/** Marketing sub-domain tool clusters (ADR-027 pattern). */
export const MARKETING_SUBAGENT_TOOLS: Record<string, AnyTool[]> = {
  social: [linkedinPost, linkedinAnalytics, draftLinkedInReply, draftConnectionNote, listScheduledPosts],
  video: [compileVideoBriefTool, compileShotListTool, planVideoProductionTool, videoProductionStatusTool, listVideoBrandsTool],
  creative: [generateImageTool, listBrandAssetsTool],
};

/** Admin sub-domain tool clusters (ADR-027 pattern). */
export const ADMIN_SUBAGENT_TOOLS: Record<string, AnyTool[]> = {
  scheduling: [scheduleTask, listScheduled, editScheduled, setReminder, listReminders, editReminder],
  memory_context: [readContext, updateContext, searchMemoryTool, recordEvent, writeArtifact, synthesizeSkill],
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
  "run_shell",
  "browser",
  "claude_code",
  "vps_run",
  "deploy_static_site",
  "project_workflow",
  "create_calendar_event",
  "record_event",
  "deliver_artifact",
  "submit_application",
  "synthesize_skill",
  "write_file",
  "send_file",
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
    "- list_video_brands / compile_video_brief = the Video Factory (video-factory/): brand-token registry + deterministic production briefs for client social videos; execution/rendering runs locally via claude_code at $0 API cost.",
    "- FounderOS also RUNS a read-only MCP server (pnpm mcp, stdio) exposing search_web, read_context, search_knowledge, search_memory, read_cv, github_read to external MCP clients; a remote client can launch it over SSH to query the VPS copy.",
  ].join("\n");
}
