/**
 * FounderOS — Pre-Router
 * =======================
 * Deterministic, pure routing rules that fire BEFORE the supervisor LLM.
 *
 * Why: Gemini at temperature 0 is still not perfectly reproducible on routing
 * (CLAUDE.md rule #16). The supervisor's routing table lives in a prompt the
 * model *may* drift from. So we push routing into a pure function with unit
 * tests, and inject the result as an ADVISORY hint (a SystemMessage) — never a
 * hard override. A misfiring rule stays LLM-correctable; a correct rule removes
 * the model's only chance to drift.
 *
 * The hint is consumed identically by the Telegram gateway and the eval harness
 * via buildOfficeInput(), so `pnpm eval` measures the REAL production path
 * (CLAUDE.md rule #19), not a router-less shortcut.
 *
 * Rule order is significant — FIRST match wins. The order encodes the
 * supervisor's DISAMBIGUATION rules (route by goal, not by an intermediate
 * step): unambiguous OS/content signals first, then job/sales/comms/research.
 */

import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";

/** The seven routable departments (matches src/agents/office.ts + eval Department). */
export type RoutableDept =
  | "research"
  | "comms"
  | "engineering"
  | "marketing"
  | "sales"
  | "personal"
  | "jobhunt";

const ROUTABLE_DEPTS: ReadonlySet<RoutableDept> = new Set<RoutableDept>([
  "research",
  "comms",
  "engineering",
  "marketing",
  "sales",
  "personal",
  "jobhunt",
]);

// ── Rule predicates (pure regex, ordered by precedence) ───────────────────────

/** `/q` and workflow steps inject "[Route directly to X department]: …". Honour it verbatim. */
const EXPLICIT_PREFIX = /\[route directly to (\w+) department\]/i;

/** Filesystem / shell / browser on the founder's Mac → personal. Highest-precedence OS signal. */
const PERSONAL_RE =
  /(^|\s)~\/|\/Users\/pushkarverma|\b(desktop|downloads|documents|home folder|projects folder)\b|files? (in|on) (my|the)\b|\.(zshrc|bashrc|ssh|env)\b|\bmy (mac|laptop|machine|computer)\b|\b(safari|browser)\b|\b(send|attach|share) (me )?(the |this )?file\b|\battachment\b|\brun (this )?in (my )?(the )?terminal\b|\bterminal:\s*\w/i;

/** Multi-department orchestration (brief + github + context) — let supervisor sequence. */
const MULTI_DEPT_ORCHESTRATION_RE =
  /\b(monday|weekly)\b[^.?!]{0,80}\b(github|issues?|context)\b|\b(github|issues?)\b[^.?!]{0,80}\b(monday|weekly|brief|plan)\b|\bresearch\b[^.?!]{0,60}\b(then|and)\b[^.?!]{0,40}\b(github|issue)\b/i;

/** LinkedIn is marketing's ONLY domain — unambiguous, checked before code/email verbs. */
const MARKETING_RE = /\blinkedin\b/i;

/** GitHub or a code-authoring request → engineering. Checked before jobhunt/comms. */
const ENGINEERING_RE =
  /\bgithub\b|\brepositor|\brepo\b|\b(write|create|build|fix|refactor|debug|implement|review)\b[^.?!]*\b(typescript|javascript|python|function|script|code|app|website|api|endpoint|component|class|module|bug|feature)\b|\b(commit|pull request|merge|rebase|push to)\b/i;

/** Job search / applications / CV — must beat sales+comms so "outreach email" for a job → jobhunt. */
const JOBHUNT_RE =
  /\bjobs?\b|\bpositions?\b|\bhiring\b|\brecruiter\b|\b(cv|resume|cover letter)\b|\bapply\b|\bapplication\b|\bopen (role|position)/i;

/** Cold outreach to an unknown company/person → sales. */
const SALES_RE = /\bcold (outreach|email)\b|\boutreach to (the )?(founder|ceo|cto|owner|head)\b/i;

/** Inbox / known-contact email / calendar → comms. */
const COMMS_RE =
  /\b(unread|inbox)\b|\bread (my )?emails?\b|\bcheck (my )?(email|inbox)\b|email (to )?[\w.+-]+@[\w.-]+|\bemail (our|my|the|him|her|them|client)\b|\bcalendar\b|\breminder\b|\bblock (time|my)\b|\bdeep work\b|\bfocus block\b/i;

/** Web facts / news / ICP scoring / memory review → research. */
const RESEARCH_RE =
  /\bresearch\b|\bnews\b|\bwhat (does|is|are|'s)\b|\bscore\b|\bICP\b|\bqualify\b|\bprospect\b|\bgood fit\b|\bthis week\b|\bweekly\b|\bmonday plan\b|\bcontext memory\b|\bopen items\b|\baccomplished\b|\bsearch for\b|\bsummari[sz]e\b|\bmarket\b|\blatest\b/i;

const RULES: ReadonlyArray<[RegExp, RoutableDept]> = [
  [PERSONAL_RE, "personal"],
  [MARKETING_RE, "marketing"],
  [ENGINEERING_RE, "engineering"],
  [JOBHUNT_RE, "jobhunt"],
  [SALES_RE, "sales"],
  [COMMS_RE, "comms"],
  [RESEARCH_RE, "research"],
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Deterministically choose a department from the raw input, or null to let the
 * supervisor decide. First matching rule wins. Pure — no I/O, no model call.
 */
export function preRouteDepartment(input: string): RoutableDept | null {
  if (!input || input.trim().length === 0) return null;

  // 0. Explicit "[Route directly to X department]" prefix overrides everything.
  const explicit = EXPLICIT_PREFIX.exec(input);
  if (explicit) {
    const dept = explicit[1]?.toLowerCase() as RoutableDept;
    if (dept && ROUTABLE_DEPTS.has(dept)) return dept;
  }

  // Multi-step cross-department requests — supervisor must orchestrate.
  if (MULTI_DEPT_ORCHESTRATION_RE.test(input)) return null;

  // 1..7 ordered keyword rules.
  for (const [pattern, dept] of RULES) {
    if (pattern.test(input)) return dept;
  }

  return null;
}

/**
 * Build the office invocation messages for a raw founder input. Used by BOTH the
 * Telegram gateway and the eval harness so they exercise the SAME routing path.
 *
 * The hint is authoritative for SINGLE-department requests: the deterministic
 * classifier is unit-tested to never misroute the golden set, so it is more
 * reliable than the LLM on ambiguous edges (e.g. "research them first, then cold
 * outreach" → sales; an explicit email address → comms). The only sanctioned
 * override is a genuine multi-step prompt that spans several departments — for
 * those the supervisor still sequences the sub-tasks itself.
 */
export function buildOfficeInput(text: string): BaseMessage[] {
  const dept = preRouteDepartment(text);
  if (!dept) return [new HumanMessage(text)];
  return [
    new SystemMessage(
      `[ROUTING DIRECTIVE: A deterministic classifier routed this to the ${dept} department. ` +
        `Transfer to ${dept} first. Only pick a different department if this is a multi-step ` +
        `request that clearly spans several departments.]`,
    ),
    new HumanMessage(text),
  ];
}

// ── Back-compat helpers (kept: existing call sites + tests depend on them) ─────

/**
 * Narrow pre-router kept for its existing unit tests. Prefer preRouteDepartment
 * for new code — it covers all seven departments.
 */
export function preRoutePersonalVsEngineering(input: string): "personal" | "engineering" | null {
  if (/github|repositor|repo\b/i.test(input)) return "engineering";
  if (/~\/|\/Users\/pushkarverma|desktop|downloads|documents|home folder/i.test(input)) {
    return "personal";
  }
  return null;
}

/** True when the input is clearly a cold-outreach request. */
export function isOutreachRequest(input: string): boolean {
  return /\boutreach\b|\bcold email\b|\breach out\b/i.test(input);
}
