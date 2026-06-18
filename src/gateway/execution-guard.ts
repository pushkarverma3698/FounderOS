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
  /\b(cannot|can't|won't|will not|unable to|refus|not (able|allowed) to)\b[^.?!]{0,80}\b(post|publish|linkedin)\b|\b(banned|prohibited|not permitted)\b[^.?!]{0,60}\b(phrase|word)|\b(too short|not long enough|word count|between \d+ and \d+ words|needs (to be|more) \d+ words?)\b/i;

export function isShellRunRequest(input: string): boolean {
  return SHELL_RUN_RE.test(input);
}

export function isLinkedInPostRequest(input: string): boolean {
  return LINKEDIN_BANNED_INPUT_RE.test(input);
}

/**
 * Extract founder-provided post body from "Post this on LinkedIn: '...'" patterns.
 * Pure — unit-tested (rule #16). Used by pre-router to force linkedin_post calls.
 */
export function extractProvidedLinkedInPost(input: string): string | null {
  const postThis = input.match(
    /\bpost\s+(?:this|the following|it)\s+on\s+linkedin\s*:?\s*['"]([^'"]+)['"]/i,
  );
  if (postThis?.[1]?.trim()) return postThis[1].trim();

  const linkedinQuoted = input.match(/\blinkedin\s*:?\s*['"]([^'"]{20,})['"]/i);
  if (linkedinQuoted?.[1]?.trim()) return linkedinQuoted[1].trim();

  return null;
}

export function isProvidedLinkedInPostRequest(input: string): boolean {
  return isLinkedInPostRequest(input) && extractProvidedLinkedInPost(input) !== null;
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
  "⚠️ I should call linkedin_post (banned phrases are auto-stripped; length is decided on the approval card). Retrying…";

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

// ── Unbacked memory / internal-knowledge claim (ADR-032) ─────────────────────
// Forces memory-tool calls before answering internal-knowledge questions.

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

export function hadAnyMemoryToolCall(messages: OfficeMessageLike[]): boolean {
  return MEMORY_TOOL_NAMES.some((name) => hadToolCall(messages, name));
}

/**
 * True when the founder asked an internal-knowledge question but the office
 * answered without calling any memory/DB tool — parametric chat, not FounderOS state.
 */
export function detectUnbackedMemoryClaim(
  userInput: string,
  messages: OfficeMessageLike[],
  reply: string,
): boolean {
  if (!isInternalKnowledgeRequest(userInput)) return false;
  if (hadAnyMemoryToolCall(messages)) return false;
  return reply.trim().length > 0;
}

export const MEMORY_RETRY_HINT =
  "⚠️ I answered without checking FounderOS memory — retrying with the database…";

// ── Knowledge / RAG grounding guard (prod ICP fabrication class) ─────────────

/** Tool returned empty store — model must refuse, not invent. */
export const EMPTY_KNOWLEDGE_RESULT_RE =
  /\b(no (knowledge|memory) (entries )?found|no memory found|nothing found|do not fabricate|may not have been synced|no information was found|does not contain (specific )?entries)\b/i;

/** RAG/embed/DB failure in a knowledge tool result — same class as empty store. */
export const KNOWLEDGE_TOOL_FAILURE_RE =
  /\b(ollama|embeddings? unreachable|rag embed|rag query|success:\s*false|search failed|unavailable at http)\b/i;

/** Partial refusal then invention — "No entry found. However, based on general understanding…" */
export const FABRICATION_BRIDGE_RE =
  /\b(however|based on (general|my) (understanding|knowledge|training)|typically targets|as a general rule|general understanding)\b/i;

/** Reply cites turicks-brain / ADR / knowledge entry — allowed specificity. */
export const CITED_KNOWLEDGE_GROUNDING_RE =
  /\b(knowledge base|turicks-brain|brain:sync|ADR-\d+|case study|according to our|entry \d+:|source_path|\[\w+\] )/i;

/**
 * Specific revenue/ARR/deal numbers on internal business questions — the prod ICP
 * fabrication used "$50,000 and $500,000". Dept tool results are hidden from the
 * supervisor (outputMode:last_message), so we must judge reply specificity.
 */
export const UNBACKED_BUSINESS_SPECIFICITY_RE =
  /\$\d{1,3}(?:,\d{3})+\s*(?:[-–—]|and|to)\s*\$?\d{1,3}(?:,\d{3})*|\$\d{1,3}[kK]\s*(?:to|[-–—])\s*\$?\d{1,3}[kK]|\b(£|€)\s*\d{1,3}(?:,\d{3})+|\bdeal value(s)?\s*(of|at)?\s*\$|\bclosed\b[^.]{0,40}\b(client|customer)\b[^.]{0,40}\$\d/i;

/** Honest refusal language — never retry these. */
export const HONEST_KNOWLEDGE_REFUSAL_RE =
  /\b(no (knowledge|memory|information|entry|entries)|doesn'?t have|does not have|don'?t have|do not have|not (found|in the knowledge)|knowledge base does not|does not contain|brain:sync|may not have|try different keywords|no matching entry)\b/i;

/** User asked about internal Turicks/business facts (not generic small talk). */
export const INTERNAL_KNOWLEDGE_REQUEST_RE =
  /\b(turicks|icp|naggar|our (brand|positioning|strategy|pillar|icp)|what (is|are) we|company context|turicks-?brain|strategic pillar)\b/i;

export const KNOWLEDGE_SEARCH_TOOLS = [
  "search_knowledge",
  "search_memory",
  "search_turicks_brain",
  "search_personal_rag",
  "read_cv",
] as const;

function toolMessageText(m: OfficeMessageLike): string {
  return typeof m.content === "string" ? m.content : "";
}

export function hadKnowledgeSearchTool(messages: OfficeMessageLike[]): boolean {
  return KNOWLEDGE_SEARCH_TOOLS.some((t) => hadToolCall(messages, t));
}

/** True when a knowledge/RAG tool ran and returned an explicit empty-store message. */
export function hadEmptyKnowledgeToolResult(messages: OfficeMessageLike[]): boolean {
  for (const m of messages) {
    const type = m._getType?.() ?? "";
    if (type !== "tool") continue;
    const name = m.name ?? "";
    if (!KNOWLEDGE_SEARCH_TOOLS.includes(name as (typeof KNOWLEDGE_SEARCH_TOOLS)[number])) continue;
    const text = toolMessageText(m);
    if (EMPTY_KNOWLEDGE_RESULT_RE.test(text) || KNOWLEDGE_TOOL_FAILURE_RE.test(text)) return true;
  }
  return false;
}

/** True when reply invents specific business metrics without citing turicks-brain. */
export function replyHasUnbackedBusinessSpecifics(reply: string): boolean {
  const text = reply.trim();
  if (!UNBACKED_BUSINESS_SPECIFICITY_RE.test(text)) return false;
  if (CITED_KNOWLEDGE_GROUNDING_RE.test(text)) return false;
  return true;
}

/** Classic ICP/strategy prose without turicks-brain citation — matches prompt-embedded ICP. */
export const UNBACKED_ICP_PROSE_RE =
  /\b(ideal customer profile|\bICP\b)[^.]{0,250}\b(SME|small to medium|ARR|annual recurring|EU|US|Europe|United States)\b/i;

export function replyHasUnbackedIcpProse(reply: string): boolean {
  const text = reply.trim();
  if (!UNBACKED_ICP_PROSE_RE.test(text)) return false;
  if (CITED_KNOWLEDGE_GROUNDING_RE.test(text)) return false;
  return true;
}

/** Confident internal-facts answer without turicks-brain citation (checkpoint purge class). */
export const INTERNAL_ANSWER_WITHOUT_GROUNDING_RE =
  /\b(ICP|ideal customer profile|strategic pillar|positioning|revenue band|annual recurring|our (clients|pillars|strategy))\b/i;

/**
 * True when an AI message in checkpoint history looks like fabricated/stale
 * Turicks knowledge — safe to purge before a fresh internal-facts turn.
 */
export function aiMessageLooksFabricatedKnowledge(content: string): boolean {
  const text = content.trim();
  if (text.length < 20) return false;
  if (HONEST_KNOWLEDGE_REFUSAL_RE.test(text) && !FABRICATION_BRIDGE_RE.test(text)) return false;
  if (CITED_KNOWLEDGE_GROUNDING_RE.test(text)) return false;
  if (replyHasUnbackedBusinessSpecifics(text)) return true;
  if (replyHasUnbackedIcpProse(text)) return true;
  if (
    FABRICATION_BRIDGE_RE.test(text) &&
    /\b(typical|typically|generally|SME|ARR|EU|US)\b/i.test(text)
  ) {
    return true;
  }
  if (INTERNAL_ANSWER_WITHOUT_GROUNDING_RE.test(text) && text.length >= 40) return true;
  return false;
}

export function buildKnowledgeGroundingRefusal(): string {
  return (
    "I don't have a verified answer for that in turicks-brain. " +
    "Search returned no matching entry (or failed). " +
    "If docs were updated recently, run `pnpm brain:sync` on the server and ask again. " +
    "I won't guess at ICP, clients, revenue bands, or deal values."
  );
}

export const INTERNAL_KNOWLEDGE_DIRECTIVE =
  "[GROUNDING DIRECTIVE: Turicks-specific facts (ICP, strategy, pillars, clients, revenue) MUST come from " +
  "search_knowledge + search_turicks_brain tool output THIS turn. If both return no entries, say ONLY that " +
  "turicks-brain has no entry — suggest brain:sync. NEVER use training data, system prompts, or prior assistant " +
  "messages in this thread (they may be stale/wrong). Do NOT use search_web for internal Turicks facts.]";

export function isInternalKnowledgeRequest(input: string): boolean {
  const text = input.trim();
  if (!text) return false;
  if (EXTERNAL_RESEARCH_RE.test(text)) return false;
  return INTERNAL_KNOWLEDGE_RE.test(text) || INTERNAL_KNOWLEDGE_REQUEST_RE.test(text);
}

/**
 * True when the model answered with confident internal business facts despite:
 * - an empty knowledge/memory/RAG tool result, OR
 * - no knowledge search at all on an internal-facts question.
 */
export function detectUnbackedKnowledgeClaim(
  userInput: string,
  messages: OfficeMessageLike[],
  reply: string,
): boolean {
  const text = reply.trim();
  if (text.length < 40) return false;

  // Partial refusal + "however based on general understanding" + specifics = fabrication.
  if (
    isInternalKnowledgeRequest(userInput) &&
    FABRICATION_BRIDGE_RE.test(text) &&
    (UNBACKED_BUSINESS_SPECIFICITY_RE.test(text) || /\b(typical|typically|generally)\b/i.test(text))
  ) {
    return true;
  }

  if (HONEST_KNOWLEDGE_REFUSAL_RE.test(text) && !FABRICATION_BRIDGE_RE.test(text)) return false;

  if (hadEmptyKnowledgeToolResult(messages)) return true;

  // Dept sub-agents use outputMode:last_message — supervisor never sees their tool
  // results. Block specific internal metrics unless the reply cites turicks-brain.
  if (isInternalKnowledgeRequest(userInput) && replyHasUnbackedBusinessSpecifics(text)) {
    return true;
  }

  if (isInternalKnowledgeRequest(userInput) && replyHasUnbackedIcpProse(text)) {
    return true;
  }

  // Stale checkpoint regurgitation: model repeats prior ICP/strategy without calling tools.
  if (isInternalKnowledgeRequest(userInput) && !hadKnowledgeSearchTool(messages)) {
    if (HONEST_KNOWLEDGE_REFUSAL_RE.test(text) && !FABRICATION_BRIDGE_RE.test(text)) return false;
    if (replyHasUnbackedBusinessSpecifics(text) || replyHasUnbackedIcpProse(text)) return true;
    if (INTERNAL_ANSWER_WITHOUT_GROUNDING_RE.test(text) && text.length >= 30) return true;
    if (text.length >= 80) return true;
  }

  return false;
}

export const KNOWLEDGE_RETRY_HINT =
  "⚠️ That answer wasn't grounded in turicks-brain — retrying with a real knowledge search…";
