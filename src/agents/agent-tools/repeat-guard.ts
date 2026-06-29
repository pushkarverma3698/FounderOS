/**
 * Repeat-call circuit breaker (T04 live 2026-06-29 — GitHub loop wedge)
 * ====================================================================
 * A weak model (Gemini 2.5 Flash) sometimes calls the SAME read tool with the
 * SAME input over and over — even when the call SUCCEEDS and the result is right
 * there in its own history. The ReAct loop never terminates and the turn dies on
 * GraphRecursionError ("🔁 stuck in a loop"). The founder gets nothing back from
 * a trivial read like "list my GitHub repositories".
 *
 * The existing consecutive-FAILURE cap (engineering.ts) does not catch this: the
 * calls succeed, so the failure counter resets every time. This guard is the
 * orthogonal protection — it bounds identical calls regardless of success.
 *
 * Deterministic (rule #16): pure key canonicalisation + a time-windowed counter,
 * so a wedged turn (~15 identical calls in <120s) is blocked after the 2nd real
 * call, while a legitimate repeat on a later turn (minutes/hours apart) is never
 * blocked. No per-turn plumbing required — the time window self-scopes to a turn.
 */

/** Canonical key for a tool call — stable across JSON key ordering / null vs absent. */
export function canonicalToolKey(toolName: string, input: unknown): string {
  return `${toolName}::${canonicalize(input)}`;
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== null && obj[k] !== undefined && obj[k] !== "")
    .sort();
  return `{${keys.map((k) => `${k}:${canonicalize(obj[k])}`).join(",")}}`;
}

export interface RepeatGuardOptions {
  /** Block the Nth identical call and every one after it (default 3). */
  maxRepeats?: number;
  /** Calls older than this many ms start a fresh streak (default 90s ≈ one turn). */
  windowMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export interface RepeatGuard {
  /**
   * Record a call and decide whether it should be SHORT-CIRCUITED.
   * Returns true once the same (tool,input) has been seen `maxRepeats` times
   * inside `windowMs` — the caller must then skip the real work and return a
   * terminal "stop, you already have this" message to the agent.
   */
  shouldBlock(toolName: string, input: unknown): boolean;
}

const DEFAULT_MAX_REPEATS = 3;
const DEFAULT_WINDOW_MS = 90_000;

export function makeRepeatGuard(opts: RepeatGuardOptions = {}): RepeatGuard {
  const maxRepeats = opts.maxRepeats ?? DEFAULT_MAX_REPEATS;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const clock = opts.now ?? Date.now;
  const seen = new Map<string, { count: number; firstTs: number }>();

  return {
    shouldBlock(toolName: string, input: unknown): boolean {
      const key = canonicalToolKey(toolName, input);
      const now = clock();
      const entry = seen.get(key);
      if (!entry || now - entry.firstTs > windowMs) {
        seen.set(key, { count: 1, firstTs: now });
        return false;
      }
      entry.count += 1;
      return entry.count >= maxRepeats;
    },
  };
}
