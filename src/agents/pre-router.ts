/**
 * FounderOS — Pre-Router (Smart Task Classifier)
 * ================================================
 * Sits BEFORE the CEO supervisor. Classifies incoming tasks in 3 layers,
 * cheapest first — escalates only when genuinely ambiguous.
 *
 * Layer 0 — Zero-LLM (instant, $0):
 *   Deterministic keyword/regex rules for obvious single-department tasks.
 *   Also catches small-talk and returns a direct answer without any routing.
 *
 * Layer 1 — Nano LLM (cheap, ~$0.00003/call):
 *   gemini-flash-lite with a tight classification prompt.
 *   Returns: sales | engineering | marketing | social | prospecting | DIRECT
 *   If DIRECT → the model writes the answer inline (for questions/small-talk).
 *
 * Layer 2 — CEO tier (expensive, escalate only):
 *   When nano returns UNCLEAR or confidence is too low.
 *   This is the existing supervisorNode — NOT called by pre-router.
 *   The pre-router sets state.department="" to signal "needs CEO".
 *
 * Anti-hallucination guarantee:
 *   Layer 0 is purely deterministic — no model involved.
 *   Layer 1 uses a constrained prompt that returns ONLY a department name or
 *   DIRECT+<answer>. The parser rejects anything outside this contract.
 *   If parsing fails → escalate to CEO (safe fallback).
 *
 * Cost savings vs current (every task → CEO):
 *   Conversational / obvious tasks: $0 (Layer 0) or ~$0.00003 (Layer 1)
 *   vs $0.003–$0.01 per CEO call (Sonnet / Gemini Pro)
 *   → ~100× cheaper for the majority of daily tasks.
 */

import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { callCascade } from "../infra/llm.js";
import type { FounderStateType } from "./state.js";
import { childLogger } from "../infra/logger.js";

const log = childLogger({ module: "pre-router" });

// ── Types ─────────────────────────────────────────────────────────────────────

type Department = "sales" | "engineering" | "marketing" | "social" | "prospecting";

interface PreRouteDecision {
  department: Department | "";  // "" = needs CEO
  directAnswer?: string;        // set when answering inline (small talk / Q&A)
  layer: 0 | 1 | 2;            // which layer made the decision
  reason: string;               // logged for observability — not shown to user
}

// ── Layer 0: Zero-LLM keyword rules ──────────────────────────────────────────

/** Small-talk phrases that should get a direct answer, no department routing */
const SMALL_TALK = /^(hi|hello|hey|sup|yo|howdy|greetings|thanks|thank you|ok|okay|nice|cool|great|got it|sounds good|perfect|awesome|cheers)[\s!.?🙏]*$/i;

/** Per-department deterministic signal patterns.
 *  Order matters: more specific patterns first. */
const DEPT_PATTERNS: Array<{ dept: Department; pattern: RegExp }> = [
  // Prospecting — must come before sales (overlapping keywords)
  {
    dept: "prospecting",
    pattern: /\b(prospect\s|icp score|icp check|qualify this|research this company|research.*\.com|score.*lead|prospect this)\b/i,
  },
  // Social — specific post/platform keywords
  {
    dept: "social",
    pattern: /\b(linkedin post|post about|write.*post|draft.*post|social media post|instagram post|tweet about|twitter post|content for linkedin|linkedin content)\b/i,
  },
  // Engineering — code/build keywords
  {
    dept: "engineering",
    pattern: /\b(write (code|a (function|class|script|module|test|hook|endpoint|handler|component))|build (a|an) (api|webhook|endpoint|service|tool|cli|app)|implement (a|an)|fix (a |the )?(bug|error|issue|test)|debug|refactor|code review|unit test|typescript function|python script|bash script)\b/i,
  },
  // Marketing
  {
    dept: "marketing",
    pattern: /\b(seo audit|marketing brief|content strategy|ad copy|campaign brief|blog post (about|for|on)|content calendar|keyword research|brand voice|marketing plan)\b/i,
  },
  // Sales — email drafts, pipeline
  {
    dept: "sales",
    pattern: /\b(cold email|outreach email|sales email|bdr email|draft.*email.*to|write.*email.*to|follow.?up email|introduction email|pitch.*to)\b/i,
  },
];

function layer0(task: string): PreRouteDecision | null {
  const trimmed = task.trim();

  // Small-talk → direct answer inline (no routing, no LLM)
  if (SMALL_TALK.test(trimmed)) {
    return {
      department: "",
      directAnswer: "👋 Hey! I'm FounderOS — your AI operating system. Send me a real task and I'll route it to the right department.\n\nTry: `/prospect stripe.com` or `draft a LinkedIn post about AI agents`.",
      layer: 0,
      reason: "small-talk keyword match",
    };
  }

  // Explicit department patterns
  for (const { dept, pattern } of DEPT_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { department: dept, layer: 0, reason: `keyword match → ${dept}` };
    }
  }

  return null; // ambiguous
}

// ── Layer 1: Nano LLM classification ─────────────────────────────────────────

const NANO_SYSTEM = `You are a task router and assistant for FounderOS, an AI operating system for Turicks (an AI automation agency run by Pushkar Verma).

DEPARTMENTS:
- sales       → cold emails, outreach, lead research, CRM pipeline
- engineering → writing code, building APIs, debugging, technical implementation
- marketing   → SEO, content strategy, ad copy, campaign planning, blog posts
- social      → LinkedIn/Instagram/Twitter posts, social media content
- prospecting → ICP scoring, company research, lead qualification

OUTPUT RULES (strict format, no exceptions):
1. Task clearly maps to ONE department → respond ONLY with the department name, lowercase.
   Example: "engineering"

2. Task is conversational, a general question, web research request, greeting, or doesn't fit any department:
   Respond with DIRECT: followed by a helpful, specific answer (2-5 sentences).
   You CAN and SHOULD answer general questions directly — you have general knowledge.
   Be specific. Mention what FounderOS can do that's relevant if applicable.
   Example: "DIRECT: Ferrari is an Italian luxury sports car manufacturer founded in 1947 by Enzo Ferrari. Known for Formula 1 dominance and iconic models like the F40 and LaFerrari. If you'd like, I can help research Ferrari as a sales prospect — try /prospect ferrari.com."

3. Genuinely ambiguous between departments → respond ONLY: UNCLEAR

DO NOT explain your reasoning. ONLY one of the three formats above.`;

async function layer1(task: string, tenantId: string): Promise<PreRouteDecision | null> {
  try {
    const result = await callCascade(
      "nano",
      [new SystemMessage(NANO_SYSTEM), new HumanMessage(task)],
      { agent: "pre_router", tenant_id: tenantId },
    );

    const raw = result.text.trim();
    log.debug({ raw, task: task.slice(0, 60) }, "Nano classification raw output");

    // Parse DIRECT answer
    if (raw.startsWith("DIRECT:")) {
      const answer = raw.slice(7).trim();
      return { department: "", directAnswer: answer, layer: 1, reason: "nano → direct answer" };
    }

    // Parse UNCLEAR → escalate to CEO
    if (raw === "UNCLEAR") {
      return null; // signal layer 2
    }

    // Parse department
    const dept = raw.toLowerCase() as Department;
    const valid: Department[] = ["sales", "engineering", "marketing", "social", "prospecting"];
    if (valid.includes(dept)) {
      return { department: dept, layer: 1, reason: `nano → ${dept}` };
    }

    // Unexpected output → safe escalation
    log.warn({ raw }, "Nano returned unexpected format — escalating to CEO");
    return null;

  } catch (err) {
    // If nano fails (no key, quota, etc.) → escalate to CEO gracefully
    log.warn({ err: (err as Error).message }, "Nano classification failed — escalating to CEO");
    return null;
  }
}

// ── Pre-Router Node ───────────────────────────────────────────────────────────

/**
 * LangGraph node — runs before supervisorNode.
 * Sets state.department directly if confident. Returns empty string to signal CEO needed.
 * Sets state.result for direct answers (small-talk / Q&A).
 */
export async function preRouterNode(
  state: FounderStateType,
): Promise<Partial<FounderStateType>> {
  // If department is already set (e.g. /prospect command bypasses supervisor entirely) — skip
  if (state.department && (state.department as string) !== "") {
    log.debug({ department: state.department }, "Pre-router: department already set, skipping");
    return {};
  }

  const task = state.task ?? "";
  const tenantId = state.tenant_id ?? "turicks";

  // Layer 0
  const l0 = layer0(task);
  if (l0) {
    log.info(
      { layer: 0, department: l0.department || "direct", reason: l0.reason, task: task.slice(0, 60) },
      "Pre-router: Layer 0 decision",
    );
    return {
      department: l0.department,
      ...(l0.directAnswer ? { result: l0.directAnswer } : {}),
    };
  }

  // Layer 1
  const l1 = await layer1(task, tenantId);
  if (l1) {
    log.info(
      { layer: 1, department: l1.department || "direct", reason: l1.reason, task: task.slice(0, 60) },
      "Pre-router: Layer 1 decision",
    );
    return {
      department: l1.department,
      ...(l1.directAnswer ? { result: l1.directAnswer } : {}),
    };
  }

  // Layer 2 — needs CEO
  log.info({ task: task.slice(0, 60) }, "Pre-router: escalating to CEO (Layer 2)");
  return {}; // state.department remains "" → routeAfterPreRouter → supervisor
}
