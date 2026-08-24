/**
 * FounderOS v2 — Agent Tools (barrel)
 * ====================================
 * LangChain-wrapped, HITL-gated tools the ReAct sub-agents call. This file was
 * split (2026-06-05) from one 660-line module into focused per-department files
 * under ./agent-tools/. This barrel re-exports them so every importer
 * (office.ts, telegram.ts) keeps working unchanged.
 *
 * Where each tool lives:
 *   agent-tools/hitl.ts        → hitlGate, ApprovalRequest, idemKey (shared core)
 *   agent-tools/research.ts    → searchWeb, scrapeUrlTool, deepResearch, crawlSiteTool, youtubeTranscript
 *   agent-tools/rag.ts         → searchResearchCache, searchPersonalRag, searchTuricksBrain
 *   agent-tools/comms.ts       → sendEmail, linkedinPost, createCalendarEvent, readEmails
 *   agent-tools/engineering.ts → githubRead, githubWrite, projectWorkflow, claudeCode
 *   agent-tools/personal.ts    → readFile, listDir, sendFile, writeFile, runShell, browser
 *   agent-tools/jobhunt.ts     → readCv, searchJobs
 *   agent-tools/memory.ts      → recordEvent
 *
 * HITL contract (read by the Telegram gateway):
 *   interrupt({ kind: "approval", action, title, summary, preview, args })
 *   resume value: "approved" | "rejected"
 * See agent-tools/hitl.ts for the interrupt() re-execution semantics.
 */

export { hitlGate, idemKey, type ApprovalRequest } from "./agent-tools/hitl.js";
export { searchWeb, scrapeUrlTool, deepResearch, crawlSiteTool, youtubeTranscript, v2exTopics } from "./agent-tools/research.js";
export { scanAiVisibility, getGapScans } from "./agent-tools/gap-scan.js";
export {
  createSendEmailTool,
  sendEmail,
  linkedinPost,
  linkedinGetMyPosts,
  linkedinAnalytics,
  linkedinReadComments,
  draftLinkedInReply,
  draftConnectionNote,
  scheduleSocialPost,
  listScheduledPosts,
  createCalendarEvent,
  readEmails,
} from "./agent-tools/comms.js";
export { githubRead, githubWrite, projectWorkflow, claudeCode, applyCinematicPreset, deployStaticSite } from "./agent-tools/engineering.js";
export { vpsRun } from "./agent-tools/vps-run.js";
export { readFile, listDir, sendFile, writeFile, runShell, browser } from "./agent-tools/personal.js";
export { readCv, searchJobs, ingestJobs, screenJob, reviewScreened, cvGaps, jobBrief, tailorCvForRow } from "./agent-tools/jobhunt.js";
export { submitApplication } from "./agent-tools/jobhunt-apply.js";
export { recordEvent } from "./agent-tools/memory.js";
export { searchPersonalRag, searchTuricksBrain, searchResearchCache } from "./agent-tools/rag.js";
export { publishSignal, prepareSignal, DEFAULT_TARGET_DEPT } from "./agent-tools/signals.js";

export { synthesizeSkill } from "../tools/skill-synthesizer.js";
export { jobState, opsState, writeArtifact, deliverArtifact } from "./agent-tools/state.js";
