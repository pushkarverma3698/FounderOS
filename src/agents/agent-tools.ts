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
 *   agent-tools/research.ts    → searchWeb
 *   agent-tools/comms.ts       → sendEmail, linkedinPost, createCalendarEvent, readEmails
 *   agent-tools/engineering.ts → githubRead, githubWrite, projectWorkflow, claudeCode
 *   agent-tools/personal.ts    → readFile, listDir, sendFile, writeFile, runShell, browser
 *   agent-tools/jobhunt.ts     → readCv, searchJobs
 *   agent-tools/memory.ts      → recordEvent
 *   agent-tools/rag.ts         → searchPersonalRag, searchTuricksBrain
 *
 * HITL contract (read by the Telegram gateway):
 *   interrupt({ kind: "approval", action, title, summary, preview, args })
 *   resume value: "approved" | "rejected"
 * See agent-tools/hitl.ts for the interrupt() re-execution semantics.
 */

export { hitlGate, idemKey, type ApprovalRequest } from "./agent-tools/hitl.js";
export { searchWeb } from "./agent-tools/research.js";
export { sendEmail, linkedinPost, createCalendarEvent, readEmails } from "./agent-tools/comms.js";
export { githubRead, githubWrite, projectWorkflow, claudeCode, deployStaticSite } from "./agent-tools/engineering.js";
export { readFile, listDir, sendFile, writeFile, runShell, browser } from "./agent-tools/personal.js";
export { readCv, searchJobs } from "./agent-tools/jobhunt.js";
export { recordEvent } from "./agent-tools/memory.js";
export { searchPersonalRag, searchTuricksBrain } from "./agent-tools/rag.js";
export { publishSignal, prepareSignal, DEFAULT_TARGET_DEPT } from "./agent-tools/signals.js";
