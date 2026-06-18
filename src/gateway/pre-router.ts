/**
 * FounderOS — Pre-Router
 * =======================
 * Deterministic, pure routing rules that fire BEFORE the supervisor LLM.
 */

import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { ENGINEERING_SUBGRAPH_ENABLED, REVENUE_SUBGRAPH_ENABLED } from "../core/config.js";
import {
  BANNED_PHRASE_INPUT_RE,
  extractProvidedLinkedInPost,
  extractShellCommand,
  INBOX_READ_ONLY_RE,
  INTERNAL_KNOWLEDGE_DIRECTIVE,
  isGithubReadOnlyRequest,
  isInternalKnowledgeRequest,
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

/** Read-only GitHub: owner/repo paths, list issues/branches (not create/write). */
const GITHUB_READ_ONLY_ROUTE_RE =
  /\bpushkarverma3698\/[\w.-]+\b|\b(list|show|get|what are)\b[^.?!]{0,60}\b(open )?(issues?|pull requests?|prs?|branches|commits)\b|\b(list|show)\b[^.?!]{0,40}\b(repos?|repositories)\b/i;

const JOBHUNT_RE =
  /\bjobs?\b|\bpositions?\b|\bhiring\b|\brecruiter\b|\b(cv|resume|cover letter)\b|\bapply\b|\bapplication\b|\bopen (role|position)/i;

const SALES_RE = /\bcold (outreach|email)\b|\boutreach to (the )?(founder|ceo|cto|owner|head)\b/i;

const COMMS_RE =
  /\b(unread|inbox)\b|\bread (my )?emails?\b|\bcheck (my )?(email|inbox)\b|email (to )?[\w.+-]+@[\w.-]+|\bemail (our|my|the|him|her|them|client)\b|\bcalendar\b|\breminder\b|\bblock (time|my)\b|\bdeep work\b|\bfocus block\b/i;

/** Business state + episodic memory (ADR-028 admin worker). */
const ADMIN_RE =
  /\b(what('s| is| are) my (current )?(focus|priorities|situation|work|background))\b|\bwhat do you know about (me|my)\b|\b(tell me|remind me) (what you know|about (me|my work|turicks))\b|\bwhat did we (discuss|decide|agree|talk about)\b|\b(log this|record (this|that|the)|remember this)\b|\bpending signals?\b/i;

const RESEARCH_RE =
  /\bresearch\b|\bnews\b|\bwhat (does|is|are|'s)\b|\bscore\b|\bICP\b|\bqualify\b|\bprospect\b|\bgood fit\b|\bopen items\b|\baccomplished\b|\bsearch for\b|\bsummari[sz]e\b|\bmarket\b|\blatest\b/i;

/** External prospecting — must use search_web, not turicks-brain (eval + prod routing). */
const EXTERNAL_LEAD_DISCOVERY_RE =
  /\bfind\b[^.?!]{0,100}\b(startups?|prospects?|leads?)\b|\b(lead|prospect) (discovery|search)\b|\bcompanies that might need\b|\braised seed\b/i;

/** Cinematic / launch-site builds — engineering must use claude_code, not project_workflow. */
const CINEMATIC_BUILD_RE =
  /\b(build|deploy|scaffold)\b[^.?!]*\b(cinematic|landing page|launch (site|page|experience))\b|\b(cinematic|neon|glass|terminal|minimal)\s+preset\b|\bcinematic-web\b/i;

const RULES: ReadonlyArray<[RegExp, RoutableDept]> = [
  [PERSONAL_RE, "personal"],
  [MARKETING_RE, "marketing"],
  [GITHUB_READ_ONLY_ROUTE_RE, "engineering"],
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

  if (CINEMATIC_BUILD_RE.test(input)) return "engineering";
  if (EXTERNAL_LEAD_DISCOVERY_RE.test(input) && !isInternalKnowledgeRequest(input)) {
    return "research";
  }

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
    const shellCmd = extractShellCommand(text);
    directive +=
      ` CRITICAL — SHELL RUN: personal MUST call run_shell immediately. ` +
      `NEVER claim the command executed or paste fake stdout without an approval card.`;
    if (shellCmd) {
      directive += ` Call run_shell with command exactly: """${shellCmd}""" — do NOT transfer back without calling it.`;
    }
  }
  if (dept === "marketing" && LINKEDIN_BANNED_INPUT_RE.test(text)) {
    const providedPost = extractProvidedLinkedInPost(text);
    directive +=
      ` CRITICAL — LINKEDIN: Call linkedin_post with the finished draft. ` +
      `NEVER refuse because of banned phrases or word count — linkedin_post auto-strips banned phrases; the founder decides length on the approval card.`;
    if (providedPost) {
      directive +=
        ` PROVIDED POST TEXT (call linkedin_post with this exact body NOW — no length check): """${providedPost.slice(0, 2500)}"""`;
    }
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
  if (dept === "research" && EXTERNAL_LEAD_DISCOVERY_RE.test(text) && !isInternalKnowledgeRequest(text)) {
    directive +=
      ` CRITICAL — EXTERNAL LEAD DISCOVERY: call search_web immediately for prospect companies. ` +
      `Do NOT call search_knowledge or search_turicks_brain — this is external market research, not Turicks internal facts. ` +
      `Score leads from web evidence; publish_signal only when icpScore ≥ 80.`;
  }
  if (dept === "research" && isInternalKnowledgeRequest(text)) {
    directive += ` CRITICAL — INTERNAL KNOWLEDGE: ${INTERNAL_KNOWLEDGE_DIRECTIVE}`;
  }
  if (dept === "admin" && isInternalKnowledgeRequest(text)) {
    directive +=
      ` CRITICAL — Use read_context + search_memory + search_knowledge via admin tools. ` +
      `If stores are empty, say so — never invent Turicks ICP/strategy from prior chat.`;
  }
  if (dept === "admin" && /\bwhat do you know about (me|my)\b|\b(tell me|remind me).*(me|my work)\b/i.test(text)) {
    directive +=
      ` CRITICAL — CONTEXT QUERY: Call read_context FIRST, then search_memory for recent decisions/work. ` +
      `Synthesize from tool output only — never say you lack personal info if read_context returned data.`;
  }
  if (dept === "engineering" && isGithubReadOnlyRequest(text)) {
    const ownerRepo = text.match(/\b([\w-]+\/[\w.-]+)\b/);
    directive +=
      ` CRITICAL — GITHUB READ: Call github_read immediately (list_issues for open issues, list_repos for repos). ` +
      `Never invent issue titles from memory — return only what the tool returns.` +
      (ownerRepo ? ` Use owner/repo ${ownerRepo[1]}.` : "");
  }
  if (
    dept === "engineering" &&
    /\b(create|file)\b[^.?!]*\b(issue|pull request|pr)\b|\bgithub\b[^.?!]*(issue|pr|pull)/i.test(text)
  ) {
    directive += ENGINEERING_SUBGRAPH_ENABLED
      ? ` CRITICAL — GITHUB WRITE: Transfer to engineering. The CTO subgraph MUST delegate to devops and call github_write or project_workflow — never claim an issue/PR was created without an approval card.`
      : ` CRITICAL — GITHUB WRITE: engineering MUST call github_write or project_workflow immediately — never claim an issue/PR was created without an approval card.`;
  }
  if (dept === "engineering" && CINEMATIC_BUILD_RE.test(text)) {
    directive +=
      ` CRITICAL — CINEMATIC BUILD: call claude_code ONCE with the complete brief (client, preset, deliverables). ` +
      `NEVER use project_workflow or hand-rolled shell for scaffolding — claude_code owns multi-step builds.`;
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

  const grounding =
    isInternalKnowledgeRequest(text) ? [new SystemMessage(INTERNAL_KNOWLEDGE_DIRECTIVE)] : [];

  const dept = preRouteDepartment(text);
  if (!dept) return [...grounding, new HumanMessage(text)];

  const humanText =
    dept === "personal" && SHELL_RUN_RE.test(text)
      ? `[Route directly to personal department]: ${text}`
      : dept === "marketing" && extractProvidedLinkedInPost(text)
        ? `[Route directly to marketing department]: ${text}`
        : dept === "engineering" && isGithubReadOnlyRequest(text)
          ? `[Route directly to engineering department]: ${text}`
          : text;

  return [
    ...grounding,
    new SystemMessage(buildRoutingDirective(dept, text)),
    new HumanMessage(humanText),
  ];
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
