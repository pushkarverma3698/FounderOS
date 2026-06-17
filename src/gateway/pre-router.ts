/**
 * FounderOS — Pre-Router
 * =======================
 * Deterministic, pure routing rules that fire BEFORE the supervisor LLM.
 */

import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { ENGINEERING_SUBGRAPH_ENABLED, REVENUE_SUBGRAPH_ENABLED } from "../core/config.js";
import {
  BANNED_PHRASE_INPUT_RE,
  INBOX_READ_ONLY_RE,
  LINKEDIN_BANNED_INPUT_RE,
  SHELL_RUN_RE,
} from "./execution-guard.js";
import { buildTaskLedgerDirective, detectTaskLedger } from "./task-ledger.js";
import {
  extractEngineeringHandoff,
  formatEngineeringHandoffEnvelope,
} from "../agents/handoff-engineering.js";

/** Routable departments (matches office.ts + eval Department). */
export type RoutableDept =
  | "admin"
  | "research"
  | "comms"
  | "engineering"
  | "marketing"
  | "sales"
  | "personal"
  | "jobhunt";

const ROUTABLE_DEPTS: ReadonlySet<RoutableDept> = new Set<RoutableDept>([
  "admin",
  "research",
  "comms",
  "engineering",
  "marketing",
  "sales",
  "personal",
  "jobhunt",
]);

const EXPLICIT_PREFIX = /\[route directly to (\w+) department\]/i;

const PERSONAL_RE =
  /(^|\s)~\/|\/Users\/pushkarverma|\b(desktop|downloads|documents|home folder|projects folder)\b|files? (in|on) (my|the)\b|\.(zshrc|bashrc|ssh|env)\b|\bmy (mac|laptop|machine|computer)\b|\b(safari|browser)\b|\b(send|attach|share) (me )?(the |this )?file\b|\battachment\b|\brun (this )?in (my )?(the )?terminal\b|\bterminal:\s*\w/i;

const MARKETING_RE = /\blinkedin\b/i;

const ENGINEERING_RE =
  /\bgithub\b|\brepositor|\brepo\b|\b(write|create|build|fix|refactor|debug|implement|review)\b[^.?!]*\b(typescript|javascript|python|function|script|code|app|website|api|endpoint|component|class|module|bug|feature)\b|\b(commit|pull request|merge|rebase|push to)\b/i;

const JOBHUNT_RE =
  /\bjobs?\b|\bpositions?\b|\bhiring\b|\brecruiter\b|\b(cv|resume|cover letter)\b|\bapply\b|\bapplication\b|\bopen (role|position)/i;

const SALES_RE = /\bcold (outreach|email)\b|\boutreach to (the )?(founder|ceo|cto|owner|head)\b/i;

const COMMS_RE =
  /\b(unread|inbox)\b|\bread (my )?emails?\b|\bcheck (my )?(email|inbox)\b|email (to )?[\w.+-]+@[\w.-]+|\bemail (our|my|the|him|her|them|client)\b|\bcalendar\b|\breminder\b|\bblock (time|my)\b|\bdeep work\b|\bfocus block\b/i;

/** Business state + episodic memory (ADR-028 admin worker). */
const ADMIN_RE =
  /\b(what('s| is| are) my (current )?(focus|priorities|situation))\b|\bwhat did we (discuss|decide|agree|talk about)\b|\b(log this|record (this|that|the)|remember this)\b|\bpending signals?\b/i;

const RESEARCH_RE =
  /\bresearch\b|\bnews\b|\bwhat (does|is|are|'s)\b|\bscore\b|\bICP\b|\bqualify\b|\bprospect\b|\bgood fit\b|\bopen items\b|\baccomplished\b|\bsearch for\b|\bsummari[sz]e\b|\bmarket\b|\blatest\b/i;

const RULES: ReadonlyArray<[RegExp, RoutableDept]> = [
  [PERSONAL_RE, "personal"],
  [MARKETING_RE, "marketing"],
  [ENGINEERING_RE, "engineering"],
  [JOBHUNT_RE, "jobhunt"],
  [SALES_RE, "sales"],
  [COMMS_RE, "comms"],
  [ADMIN_RE, "admin"],
  [RESEARCH_RE, "research"],
];

/** Map marketing/sales → revenue when the revenue subgraph flag is on. */
export function resolveSupervisorTarget(dept: RoutableDept): string {
  if (REVENUE_SUBGRAPH_ENABLED && (dept === "marketing" || dept === "sales")) {
    return "revenue";
  }
  return dept;
}

export function preRouteDepartment(input: string): RoutableDept | null {
  if (!input || input.trim().length === 0) return null;

  const explicit = EXPLICIT_PREFIX.exec(input);
  if (explicit) {
    const dept = explicit[1]?.toLowerCase() as RoutableDept;
    if (dept && ROUTABLE_DEPTS.has(dept)) return dept;
  }

  if (detectTaskLedger(input)) return null;

  for (const [pattern, dept] of RULES) {
    if (pattern.test(input)) return dept;
  }

  return null;
}

function buildRoutingDirective(dept: RoutableDept, text: string): string {
  const target = resolveSupervisorTarget(dept);
  let directive =
    `[ROUTING DIRECTIVE: A deterministic classifier routed this to the ${dept} department. ` +
    `Transfer to ${target} first. Only pick a different department if this is a multi-step ` +
    `request that clearly spans several departments.]`;

  if (dept === "admin") {
    directive +=
      ` CRITICAL — ADMIN: Use read_context / search_memory / update_context / record_event as appropriate. ` +
      `You have NO business tools yourself — delegate to admin.`;
  }
  if (dept === "personal" && SHELL_RUN_RE.test(text)) {
    directive +=
      ` CRITICAL — SHELL RUN: personal MUST call run_shell immediately. ` +
      `NEVER claim the command executed or paste fake stdout without an approval card.`;
  }
  if (dept === "marketing" && LINKEDIN_BANNED_INPUT_RE.test(text)) {
    directive +=
      ` CRITICAL — LINKEDIN: Call linkedin_post with the finished draft. ` +
      `NEVER refuse because of banned phrases — linkedin_post auto-strips them before the approval card.`;
    if (BANNED_PHRASE_INPUT_RE.test(text)) {
      directive += ` The user's input contains banned phrases — strip them in your draft and call the tool anyway.`;
    }
  }
  if (dept === "comms" && INBOX_READ_ONLY_RE.test(text) && !/\b(draft|reply|send|write|respond)\b/i.test(text)) {
    const query = /\bunread\b/i.test(text) ? "is:unread" : "in:inbox";
    directive +=
      ` CRITICAL — INBOX READ: Call read_emails immediately with query "${query}". ` +
      `Return sender + subject lines from the tool output — NEVER summarize without calling read_emails.`;
  }
  if (
    dept === "engineering" &&
    /\b(create|open|file)\b[^.?!]*\b(issue|pull request|pr)\b|\bgithub\b[^.?!]*(issue|pr|pull)/i.test(text)
  ) {
    directive += ENGINEERING_SUBGRAPH_ENABLED
      ? ` CRITICAL — GITHUB WRITE: Transfer to engineering. The CTO subgraph MUST delegate to devops and call github_write or project_workflow — never claim an issue/PR was created without an approval card.`
      : ` CRITICAL — GITHUB WRITE: engineering MUST call github_write or project_workflow immediately — never claim an issue/PR was created without an approval card.`;
  }
  if (dept === "engineering") {
    const handoff = extractEngineeringHandoff(text);
    directive += ` ${formatEngineeringHandoffEnvelope(handoff)}`;
  }
  return directive;
}

export function buildOfficeInput(text: string): BaseMessage[] {
  const ledger = detectTaskLedger(text);
  if (ledger) {
    return [new SystemMessage(buildTaskLedgerDirective(ledger)), new HumanMessage(text)];
  }

  const dept = preRouteDepartment(text);
  if (!dept) return [new HumanMessage(text)];

  const humanText =
    dept === "personal" && SHELL_RUN_RE.test(text)
      ? `[Route directly to personal department]: ${text}`
      : text;

  return [new SystemMessage(buildRoutingDirective(dept, text)), new HumanMessage(humanText)];
}

export function preRoutePersonalVsEngineering(input: string): "personal" | "engineering" | null {
  if (/github|repositor|repo\b/i.test(input)) return "engineering";
  if (/~\/|\/Users\/pushkarverma|desktop|downloads|documents|home folder/i.test(input)) {
    return "personal";
  }
  return null;
}

export function isOutreachRequest(input: string): boolean {
  return /\boutreach\b|\bcold email\b|\breach out\b/i.test(input);
}
