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
  sendEmail,
  readEmails,
  linkedinPost,
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
  recordEvent,
  searchPersonalRag,
  searchTuricksBrain,
} from "./agent-tools.js";
import { readContext, updateContext } from "../tools/context.js";
import { searchKnowledge } from "../tools/knowledge.js";
import { searchMemoryTool } from "../tools/memory.js";

// Tool generics are heterogeneous across departments; the graph only needs
// `.name` + invokability, both checked by tests. Typing the union precisely
// buys nothing and fights every LangChain minor release.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = any;

/** Department → tools. office.ts builds each ReAct agent from THESE arrays. */
export const DEPARTMENT_TOOLS: Record<string, AnyTool[]> = {
  research: [searchWeb, searchKnowledge],
  comms: [sendEmail, readEmails, createCalendarEvent],
  engineering: [githubRead, githubWrite, projectWorkflow, claudeCode],
  marketing: [searchWeb, linkedinPost, searchKnowledge],
  sales: [searchWeb, sendEmail, searchKnowledge],
  personal: [readFile, listDir, sendFile, writeFile, runShell, browser, searchPersonalRag, searchTuricksBrain],
  jobhunt: [readCv, searchJobs, sendEmail],
};

/** Supervisor-level tools (not delegated to departments). */
export const SUPERVISOR_TOOLS: AnyTool[] = [readContext, updateContext, searchMemoryTool, recordEvent];

/** Tools that pause for founder approval (HITL interrupt) before acting. */
export const HITL_GATED_TOOLS = new Set([
  "send_email",
  "linkedin_post",
  "github_write",
  "write_file",
  "run_shell",
  "browser",
  "send_file",
  "claude_code",
  "project_workflow",
  "create_calendar_event",
  "record_event",
]);

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
    `- supervisor (you): ${SUPERVISOR_TOOLS.map((t) => (HITL_GATED_TOOLS.has(t.name) ? `${t.name}*` : t.name)).join(", ")}`,
    "Notes:",
    "- claude_code = a full Claude Code coding agent (files, shell, git, gh) in an isolated workspace — engineering's primary executor for any build/code/repo task.",
    "- browser = Safari automation on the founder's Mac (personal dept).",
    "- FounderOS also RUNS an MCP server on localhost:3100 exposing search_web, read_context, search_knowledge, search_memory, read_cv, github_read to external MCP clients.",
  ].join("\n");
}
