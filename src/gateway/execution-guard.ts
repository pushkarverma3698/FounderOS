/**
 * FounderOS — Execution Claim Guard
 * ==================================
 * Deterministic detection of hallucinated tool execution — when the model
 * claims a shell command ran (or pasted fake stdout) without actually calling
 * the gated run_shell tool. Pure functions, unit-tested (rule #16).
 */

export interface OfficeMessageLike {
  content: unknown;
  _getType?: () => string;
  tool_calls?: unknown[];
  name?: string;
}

/** User asked to run a shell command / terminal task. */
export const SHELL_RUN_RE =
  /\brun\b[^.?!]{0,80}\b(echo|terminal|shell|command|script)\b|\bterminal:\s*\S|\brun (this )?in (my )?(the )?terminal\b|\bexecute\b[^.?!]{0,40}\b(command|script)\b/i;

/** Reply language that implies execution happened without a HITL card. */
export const FAKE_SHELL_CLAIM_RE =
  /\b(executed|ran the command|command (was )?run|here(?:'s| is) the output|stdout|stderr|output of the command)\b/i;

/** Supervisor deferred shell work back to the user instead of routing to personal. */
export const SHELL_DEFERRAL_RE =
  /\b(can't|cannot|unable to)\b[^.?!]{0,50}\b(execut|run)\b|\brun (it |this )?(yourself|in your terminal)\b|\byou can run\b[^.?!]{0,40}\bterminal\b/i;

/** LinkedIn post request with banned phrases the model may refuse instead of calling the tool. */
export const LINKEDIN_BANNED_INPUT_RE =
  /\blinkedin\b/i;

export const BANNED_PHRASE_INPUT_RE =
  /game-?chang|synergy|innovative solution|excited to (share|announce)|thrilled to share/i;

/** Model refused to post instead of calling linkedin_post. */
export const LINKEDIN_REFUSAL_RE =
  /\b(cannot|can't|won't|will not|unable to|refus|not (able|allowed) to)\b[^.?!]{0,80}\b(post|publish|linkedin)\b|\b(banned|prohibited|not permitted)\b[^.?!]{0,60}\b(phrase|word)/i;

export function isShellRunRequest(input: string): boolean {
  return SHELL_RUN_RE.test(input);
}

export function isLinkedInPostRequest(input: string): boolean {
  return LINKEDIN_BANNED_INPUT_RE.test(input);
}

export function hadToolCall(messages: OfficeMessageLike[], toolName: string): boolean {
  for (const m of messages) {
    const type = m._getType?.() ?? "";
    if (type === "ai" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const name =
          typeof tc === "object" && tc !== null && "name" in tc
            ? String((tc as { name: string }).name)
            : "";
        if (name === toolName) return true;
      }
    }
    if (type === "tool" && m.name === toolName) return true;
  }
  return false;
}

/**
 * True when the office completed without HITL but the reply claims shell output
 * the run_shell tool never produced.
 */
export function detectUnbackedShellClaim(
  userInput: string,
  messages: OfficeMessageLike[],
  reply: string,
): boolean {
  if (!isShellRunRequest(userInput)) return false;
  if (hadToolCall(messages, "run_shell")) return false;
  return FAKE_SHELL_CLAIM_RE.test(reply) || SHELL_DEFERRAL_RE.test(reply);
}

/**
 * True when user asked for LinkedIn content but marketing replied with refusal
 * prose instead of calling linkedin_post (tool auto-strips banned phrases).
 */
export function detectLinkedInRefusalWithoutTool(
  userInput: string,
  messages: OfficeMessageLike[],
  reply: string,
): boolean {
  if (!isLinkedInPostRequest(userInput)) return false;
  if (hadToolCall(messages, "linkedin_post")) return false;
  return LINKEDIN_REFUSAL_RE.test(reply);
}

export const SHELL_RETRY_HINT =
  "⚠️ That command was not actually run — I need your approval first. Retrying with the real run_shell tool…";

export const LINKEDIN_RETRY_HINT =
  "⚠️ I should call linkedin_post (banned phrases are auto-stripped). Retrying…";

/** Read-only inbox check — excludes draft/reply/send workflows. */
export const INBOX_READ_ONLY_RE =
  /\b(check|read|show|list|any|what(?:'s| is) in)\b[^.?!]{0,50}\b(unread )?(emails?|inbox)\b|\b(unread|inbox)\b[^.?!]{0,40}\b(check|emails?)\b|\bcheck my unread emails?\b/i;

/** Vague inbox summary without listing senders/subjects. */
export const FAKE_INBOX_CLAIM_RE =
  /\b(several|some|many|a few|multiple)\b[^.?!]{0,40}\b(unread )?emails?\b|\b(you have|there are)\b[^.?!]{0,40}\b(unread )?emails?\b|\b(review them|need your attention)\b/i;

export function isInboxReadOnlyRequest(input: string): boolean {
  const text = input.trim();
  if (!text || !INBOX_READ_ONLY_RE.test(text)) return false;
  if (/\b(draft|reply|send|write|respond|compose|forward)\b/i.test(text)) return false;
  return true;
}

export function detectUnbackedInboxClaim(
  userInput: string,
  messages: OfficeMessageLike[],
  reply: string,
): boolean {
  if (!isInboxReadOnlyRequest(userInput)) return false;
  if (hadToolCall(messages, "read_emails")) return false;
  return FAKE_INBOX_CLAIM_RE.test(reply);
}

export const INBOX_RETRY_HINT =
  "⚠️ That inbox summary was not from Gmail — retrying with read_emails…";

// ── Unbacked memory / internal-knowledge claim ──────────────────────────────────
// The single most damaging prod failure mode (2026-06-17): a weak or swapped model
// answers business/memory questions from its own parametric weights — which know
// nothing about Turicks/Naggar — instead of calling a DB/memory tool, so it
// hallucinates. The tool-layer anti-fabricate sentinels (context.ts, knowledge.ts)
// only fire if the tool is actually CALLED. This guard makes the discipline
// deterministic and model-agnostic: if the founder asks an internal-knowledge
// question and zero memory tools fired this turn, force a retry that calls one.

/** The DB/memory-backed tools that must answer internal-knowledge questions. */
export const MEMORY_TOOL_NAMES = [
  "read_context",
  "search_memory",
  "search_knowledge",
  "search_turicks_brain",
] as const;

/** Question is about OUR business / stored decisions / founder context. */
export const INTERNAL_KNOWLEDGE_RE =
  /\b(turicks|naggar)\b|\bour\b[^.?!]{0,40}\b(icp|strateg|pricing|price|roadmap|clients?|customers?|offer(?:ing)?s?|services?|positioning|brand|goals?|plans?|stack|vision|mission)\b|\bwhat did we (decide|agree|discuss|choose|pick)\b|\b(do you|what do you)\b[^.?!]{0,20}\b(remember|recall|know)\b[^.?!]{0,40}\b(we|our|i|my|decid|agree)\b|\bfounder(?:'s)? (context|notes?|preferences?)\b|\bmy (notes?|context|preferences?)\b/i;

/** Explicit external/web research — legitimately skips memory tools. */
export const EXTERNAL_RESEARCH_RE =
  /\b(search (the )?web|google (it|for)|look (it )?up online|latest news|news about|competitors?|market research|on the (web|internet))\b/i;

export function isInternalKnowledgeRequest(input: string): boolean {
  const text = input.trim();
  if (!text || !INTERNAL_KNOWLEDGE_RE.test(text)) return false;
  if (EXTERNAL_RESEARCH_RE.test(text)) return false;
  return true;
}

export function hadAnyMemoryToolCall(messages: OfficeMessageLike[]): boolean {
  return MEMORY_TOOL_NAMES.some((name) => hadToolCall(messages, name));
}

/**
 * True when the founder asked an internal-knowledge question but the office
 * answered (or asked back) without calling any memory/DB tool — i.e. the reply
 * is sourced from the model's parametric memory, not FounderOS state. Fail-safe:
 * if a memory tool fired, we never flag (the tool's own sentinel governs empties).
 */
export function detectUnbackedMemoryClaim(
  userInput: string,
  messages: OfficeMessageLike[],
  reply: string,
): boolean {
  if (!isInternalKnowledgeRequest(userInput)) return false;
  if (hadAnyMemoryToolCall(messages)) return false;
  // Any non-empty reply here is necessarily un-sourced (no tool ran): whether it
  // fabricated an answer or asked the founder back without checking first, the
  // correct move is identical — retry and force the memory tool (SELF-QUERY rule).
  return reply.trim().length > 0;
}

export const MEMORY_RETRY_HINT =
  "⚠️ I answered without checking FounderOS memory — retrying with the database…";
