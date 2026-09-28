/**
 * FounderOS — Jev AI System 1 Decision Gateway & Pre-Filter
 * ==========================================================
 * Fast, low-latency System 1 deterministic gateway and RAG context pre-filter.
 *
 * Responsibilities:
 *  1. System 1 Router Gateway: immediate, low-latency deterministic decision-making
 *     and route evaluation before falling back to full LLM processing.
 *  2. RAG Context Pre-filtering: trim, filter, deduplicate, and score RAG search results / document context.
 *  3. Tool Dispatch Validation: pre-execution validation checks using Jev AI rules.
 *  4. Fallback Safety: maintains existing interfaces and ensures fallback to standard behavior if disabled/unavailable.
 */

/** Minimum RAG similarity/relevance score threshold. */
export const JEV_RAG_MIN_SCORE = 0.15;

/** Maximum text length for RAG context chunks before trimming. */
export const JEV_RAG_MAX_LENGTH = 1500;

/** Default engine enablement flag. */
export const JEV_DEFAULT_ENABLED = true;

export interface JevAIOptions {
  readonly enabled?: boolean;
  readonly minScore?: number;
  readonly maxContentLength?: number;
  readonly customRules?: Record<string, unknown>;
}

export interface JevSystem1RouteResult {
  readonly handled: boolean;
  readonly route?: string;
  readonly confidence?: number;
  readonly decision?: string;
  readonly targetStepIndex?: number;
  readonly reason?: string;
}

export interface JevRagContextFilterInput {
  readonly id?: string;
  readonly text: string;
  readonly score?: number;
  readonly source?: string;
  readonly [key: string]: unknown;
}

export interface JevRagContextFilterOutput {
  readonly filtered: JevRagContextFilterInput[];
  readonly originalCount: number;
  readonly filteredCount: number;
  readonly trimmedBytes: number;
}

export interface JevToolValidationResult {
  readonly valid: boolean;
  readonly reason?: string;
  readonly sanitizedArgs?: Record<string, unknown>;
}

export class JevAIService {
  private readonly enabled: boolean;
  private readonly minScore: number;
  private readonly maxContentLength: number;

  constructor(options: JevAIOptions = {}) {
    this.enabled = options.enabled ?? JEV_DEFAULT_ENABLED;
    this.minScore = options.minScore ?? JEV_RAG_MIN_SCORE;
    this.maxContentLength = options.maxContentLength ?? JEV_RAG_MAX_LENGTH;
  }

  public isAvailable(): boolean {
    return this.enabled;
  }

  /**
   * Fast System 1 deterministic gateway router evaluation.
   */
  public evaluateSystem1Routing(input: { intent?: string; prompt?: string; state?: unknown }): JevSystem1RouteResult {
    if (!this.enabled) {
      return { handled: false, reason: "Jev AI engine disabled" };
    }

    const text = (input.intent || input.prompt || "").trim().toLowerCase();
    if (!text) {
      return { handled: false, reason: "Empty input" };
    }

    if (text === "ping" || text === "health") {
      return {
        handled: true,
        route: "system_health",
        confidence: 1.0,
        decision: "SYSTEM_1_HEALTH_PONG",
      };
    }

    if (text === "status" || text === "get status") {
      return {
        handled: true,
        route: "system_status",
        confidence: 1.0,
        decision: "SYSTEM_1_STATUS_CHECK",
      };
    }

    if (text === "cancel" || text === "abort" || text === "stop") {
      return {
        handled: true,
        route: "system_cancel",
        confidence: 1.0,
        decision: "SYSTEM_1_CANCEL_MISSION",
      };
    }

    return { handled: false, reason: "No System 1 deterministic match; fallback to LLM processing" };
  }

  /**
   * Context pre-filtering to trim and filter RAG search results and document context.
   */
  public preFilterRagContext(
    items: readonly JevRagContextFilterInput[],
    options: { topK?: number } = {},
  ): JevRagContextFilterOutput {
    const originalCount = items.length;
    if (!this.enabled || originalCount === 0) {
      return {
        filtered: [...items],
        originalCount,
        filteredCount: originalCount,
        trimmedBytes: 0,
      };
    }

    let trimmedBytes = 0;
    const seenTexts = new Set<string>();
    const filtered: JevRagContextFilterInput[] = [];

    for (const item of items) {
      if (typeof item.score === "number" && Number.isFinite(item.score) && item.score < this.minScore) {
        continue;
      }

      const normalizedText = item.text.trim().toLowerCase();
      if (seenTexts.has(normalizedText)) {
        continue;
      }
      seenTexts.add(normalizedText);

      let text = item.text;
      if (text.length > this.maxContentLength) {
        const excess = text.length - this.maxContentLength;
        trimmedBytes += excess;
        text = text.slice(0, this.maxContentLength) + "... [trimmed by Jev AI]";
      }

      filtered.push({
        ...item,
        text,
      });

      if (options.topK && filtered.length >= options.topK) {
        break;
      }
    }

    return {
      filtered,
      originalCount,
      filteredCount: filtered.length,
      trimmedBytes,
    };
  }

  /**
   * Pre-execution validation check using Jev AI rules before tool dispatch.
   */
  public validateToolDispatch(toolName: string, args: Record<string, unknown>): JevToolValidationResult {
    if (!this.enabled) {
      return { valid: true, sanitizedArgs: args };
    }

    if (!toolName || typeof toolName !== "string") {
      return { valid: false, reason: "Tool name must be a non-empty string" };
    }

    if (!args || typeof args !== "object" || Array.isArray(args)) {
      return { valid: false, reason: "Tool arguments must be a plain object" };
    }

    if (Object.prototype.hasOwnProperty.call(args, "__proto__") || Object.prototype.hasOwnProperty.call(args, "constructor")) {
      return { valid: false, reason: "Forbidden parameter in tool arguments" };
    }

    return { valid: true, sanitizedArgs: args };
  }
}

export const jevAIService = new JevAIService();

export function evaluateJevSystem1Route(input: { intent?: string; prompt?: string; state?: unknown }): JevSystem1RouteResult {
  return jevAIService.evaluateSystem1Routing(input);
}

export function preFilterJevRagContext(
  items: readonly JevRagContextFilterInput[],
  options?: { topK?: number },
): JevRagContextFilterOutput {
  return jevAIService.preFilterRagContext(items, options);
}

export function validateJevToolDispatch(toolName: string, args: Record<string, unknown>): JevToolValidationResult {
  return jevAIService.validateToolDispatch(toolName, args);
}
