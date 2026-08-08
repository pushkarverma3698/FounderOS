/**
 * FounderOS v2 — System Prompts (barrel)
 * =======================================
 * One tight prompt per role, each in its own file under ./prompts/ so a
 * developer can open exactly the prompt they need:
 *
 *   prompts/supervisor.ts   — the router (SUPERVISOR_PROMPT, buildSupervisorPrompt)
 *   prompts/research.ts      — RESEARCH_PROMPT
 *   prompts/comms.ts         — buildCommsPrompt (date-injected)
 *   prompts/engineering.ts   — ENGINEERING_PROMPT
 *   prompts/marketing.ts     — MARKETING_PROMPT
 *   prompts/sales.ts         — SALES_PROMPT
 *   prompts/personal.ts      — PERSONAL_PROMPT
 *   prompts/jobhunt.ts       — JOBHUNT_PROMPT
 *   prompts/scheduler.ts     — SCHEDULER_BRIEF_PROMPT (proactive Monday brief)
 *   prompts/brand.ts         — BRAND_BANNED_SECTION (shared by comms/sales/marketing)
 *
 * The founder is Pushkar Verma — solo founder of Turicks (AI automation agency)
 * and Naggar Retreat. FounderOS is his Telegram-based company operating system.
 *
 * Departments (8): admin · research · comms · engineering · marketing · sales · personal · jobhunt
 *
 * Architecture decision (2026-06-05): each tool has exactly ONE department owner
 * (prospecting merged into research; linkedin_post → marketing only; read_emails
 * → comms only) so there is no routing ambiguity.
 *
 * This file is a barrel: importers keep using `./system-prompts.js` unchanged.
 */

export { ADMIN_PROMPT } from "./prompts/admin.js";
export { RESEARCH_PROMPT } from "./prompts/research.js";
export { buildCommsPrompt } from "./prompts/comms.js";
export { ENGINEERING_PROMPT } from "./prompts/engineering.js";
export { MARKETING_PROMPT } from "./prompts/marketing.js";
export { SALES_PROMPT } from "./prompts/sales.js";
export { PERSONAL_PROMPT } from "./prompts/personal.js";
export { JOBHUNT_PROMPT } from "./prompts/jobhunt.js";
export { SCHEDULER_BRIEF_PROMPT } from "./prompts/scheduler.js";
