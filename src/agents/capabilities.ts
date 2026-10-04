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
  readLogs,
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
  projectWorkflow,
  claudeCode,
  dispatchAntigravityTask,
  createProjectRepo,
  applyCinematicPreset,
  deployStaticSite,
  recordEvent,
  recallConversationTool,
  publishSignal,
  scanAiVisibility,
  getGapScans,
  vpsRun,
  jobState,
  exportJobsCsv,
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
import { antigravityTaskStatus, requeueAntigravityTask } from "./agent-tools/antigravity-followup.js";
import { readContext, updateContext } from "../tools/context.js";
import { searchKnowledge } from "../tools/knowledge.js";
import { searchMemoryTool } from "../tools/memory.js";
import { listPendingSignals } from "./agent-tools/pending-signals.js";
import { MCP_BRIDGE_ENABLED, MCP_BRIDGE_MANIFEST } from "../core/config.js";
import type { RagTable } from "../db/rag-search.js";
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
 * RAG placement. P7 (5623eff) left one retrieval surface per corpus, so two
 * workers never answer the same question from different indexes. 2026-09-28
 * added the per-worker half: one reader per table, checked against
 * RETRIEVAL_TOOL_TABLE below. Where each RAG table is read (pinned by
 * tests/unit/agents/capabilities.test.ts):
 *
 * brain_memories → marketing + research + sales
 * research_cache → research
 * personal_rag   → none
 *
 * brain_memories: business knowledge (strategy, ADRs, brand, founder profile),
 *   read only through searchKnowledge. research also held searchTuricksBrain,
 *   the same engine over the same table, and on 2026-09-26 called both for one
 *   query; searchKnowledge took its only advantage (top_k up to 10) instead.
 *   The UnifiedTool stays in src/tools/rag.ts for scripts/probe-rag.ts and the
 *   VPS QA probes, bound to no worker.
 *
 * personal_rag: no worker reads it. CV and career questions belong to jobhunt,
 *   which reads the CV the founder maintains through readCv/cvGaps (P7 made it
 *   the one CV reader). personal held searchPersonalRag until 2026-09-28 and
 *   answered "what are my skills?" from it — 4 prod rows, last written
 *   2026-06-15, a wiki stub. It got no CV tool in exchange: the planner routes
 *   on each worker's tool list as well as its description, and a second CV
 *   route is how personal won "What is Tashi's CV background?" on 2026-09-07
 *   (tests/unit/gateway/jobhunt-department-routing.test.ts).
 */
import { synthesizeSkill } from "./agent-tools.js";
import { uiCheck } from "./agent-tools/ui-qa.js";

export const DEPARTMENT_TOOLS: Record<string, AnyTool[]> = {
  admin: [readContext, updateContext, searchMemoryTool, recallConversationTool, recordEvent, listPendingSignals, scheduleTask, listScheduled, editScheduled, setReminder, listReminders, editReminder, listWorkflows, synthesizeSkill, opsState, writeArtifact, deliverArtifact, readLogs],
  research: [searchWeb, scrapeUrlTool, deepResearch, crawlSiteTool, youtubeTranscript, v2exTopics, searchResearchCache, searchKnowledge, publishSignal, scanAiVisibility, getGapScans],
  comms: [createSendEmailTool("comms"), readEmails, createCalendarEvent, scheduleSocialPost, listScheduledPosts],
  engineering: [projectWorkflow, claudeCode, dispatchAntigravityTask, antigravityTaskStatus, requeueAntigravityTask, createProjectRepo, applyCinematicPreset, deployStaticSite, vpsRun, synthesizeSkill, githubRead, uiCheck, readLogs],
  marketing: [linkedinPost, linkedinGetMyPosts, linkedinAnalytics, linkedinReadComments, draftLinkedInReply, draftConnectionNote, generateImageTool, listBrandAssetsTool, listVideoBrandsTool, compileVideoBriefTool, compileShotListTool, planVideoProductionTool, videoProductionStatusTool, listScheduledPosts, searchWeb, searchKnowledge, publishSignal],
  sales: [searchWeb, createSendEmailTool("sales"), searchKnowledge],
  personal: [readFile, listDir, runShell, browser, sendFile, writeFile],
  // submitApplication (VPS-lane submit) retired 2026-08-25 — founder decision,
  // the Mac client (mac-client/mac_client/apply.py) is the one apply lane now.
  // Tombstoned in verify-architecture.ts so it cannot return by accident.
  jobhunt: [readCv, searchJobs, ingestJobs, screenJob, reviewScreened, cvGaps, jobState, exportJobsCsv, tailorCvForRow, writeArtifact, deliverArtifact, jobBrief, createSendEmailTool("jobhunt")],
};

/**
 * The RAG table each retrieval tool reads. Declared rather than inferred so the
 * one-reader-per-table rule has something to be checked against, and listed
 * whether or not a worker holds the tool, so re-binding a retired one is caught
 * by name. tests/unit/agents/retrieval-tool-table.test.ts fails on a worker
 * holding two readers of one table, on a worker tool that reaches the RAG engine
 * with no entry here, and on an entry the tool does not actually honour.
 */
export const RETRIEVAL_TOOL_TABLE: Readonly<Record<string, RagTable>> = {
  search_knowledge: "brain_memories",
  search_turicks_brain: "brain_memories",
  search_research_cache: "research_cache",
  search_personal_rag: "personal_rag",
};

/** Engineering CTO subgraph — per-sub-agent tools (coder/qa/devops). */
export const ENGINEERING_SUBAGENT_TOOLS: Record<string, AnyTool[]> = {
  coder: [claudeCode, dispatchAntigravityTask, githubRead, synthesizeSkill],
  qa: [claudeCode, githubRead, uiCheck, readLogs],
  devops: [claudeCode, projectWorkflow, readLogs],
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
  memory_context: [readContext, updateContext, searchMemoryTool, recallConversationTool, recordEvent, writeArtifact, synthesizeSkill],
};

/** Supervisors route via handoffs only — no business tools (ADR-028). */
export const SUPERVISOR_TOOLS: AnyTool[] = [];

import { HITL_GATED_TOOLS } from "../infra/hitl.js";

/** Tools that pause for founder approval (HITL interrupt) before acting. */
export { HITL_GATED_TOOLS };



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
    "- claude_code = a full Claude Code coding agent (files, shell, git, gh) in an isolated workspace — engineering's FALLBACK executor, only for a standalone build that has no repository yet; a change to an existing repository is dispatched, never run here.",
    "- dispatch_antigravity_task = dispatches an engineering/code task to Google Antigravity on the VPS by creating a structured issue (label agent:ready) on an allowlisted repository: FounderOS, the Oplify repos, Hulda, any project repo this instance created. The VPS agent-dispatch loop claims it within a minute, opens a draft PR, and an independent reviewer (pr-brain) reviews it. The executor is Antigravity or Claude Code: the founder's /claude or /agy command, or his /engine default, decides which; the approval card names it.",
    "- apply_cinematic_preset = copies cinematic-web preset scaffold (neon/glass/terminal/minimal) before landing page builds.",
    "- browser = Safari automation on the founder's Mac (personal dept).",
    "- list_video_brands / compile_video_brief = the Video Factory (video-factory/): brand-token registry + deterministic production briefs for client social videos; execution/rendering runs locally via claude_code at $0 API cost.",
    "- FounderOS also RUNS a read-only MCP server (pnpm mcp, stdio) exposing search_web, read_context, search_knowledge, search_memory, read_cv, github_read to external MCP clients; a remote client can launch it over SSH to query the VPS copy.",
  ].join("\n");
}
