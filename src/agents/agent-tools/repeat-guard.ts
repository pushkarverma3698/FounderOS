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
 * Deterministic (rule #16): pure key canonicalisation + a plain counter. There is
 * NO time window. The counter is scoped to one STEP: the worker puts
 * `step_scope = "<turnId>:<stepId>"` in `config.configurable` and the tools key
 * their guard by it (see `repeatGuardScope`). A later turn, or a later step, gets
 * a fresh counter, so the founder asking the same question three times in two
 * minutes is never blocked. (AG-046: a thread-wide 90s window did block it, and the
 * block message then told the worker a result was "in the conversation above" that
 * its isolated context had never seen.) With no step scope (tests, scripts) the
 * guard falls back to the thread id.
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
  /** Identical calls allowed per guard instance; the next one is blocked (default 3). */
  maxRepeats?: number;
}

export interface RepeatGuard {
  /**
   * Record a call and decide whether it should be SHORT-CIRCUITED.
   * Returns true once the same (tool,input) has already been allowed `maxRepeats`
   * times on this guard (so the 4th identical call by default) — the caller must
   * then skip the real work and return a terminal "stop, you already have this"
   * message to the agent.
   */
  shouldBlock(toolName: string, input: unknown): boolean;
}

const DEFAULT_MAX_REPEATS = 3;

export function makeRepeatGuard(opts: RepeatGuardOptions = {}): RepeatGuard {
  const maxRepeats = opts.maxRepeats ?? DEFAULT_MAX_REPEATS;
  const seen = new Map<string, number>();

  return {
    shouldBlock(toolName: string, input: unknown): boolean {
      const key = canonicalToolKey(toolName, input);
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      return count > maxRepeats;
    },
  };
}

// ── Scoped registry (context-isolation fix, 2026-06-30; per-step, AG-046) ───
//
// Any stateful loop-guard (this one, or the consecutive-failure counter in
// engineering.ts) MUST be scoped (thread, or thread + step), never created once
// at module scope. The office graph is compiled ONCE (rule #2) and tools are
// bound at that time, so a module-level `const guard = makeRepeatGuard()`
// lives for the entire process and is silently shared by every thread —
// directly violating rule #20 (no context leakage across any graph boundary).
// `makeThreadScopedRegistry` gives each scope key its own lazily-created
// instance so one thread's (or step's) call history can never block or bleed
// into another's. Step scopes are never released explicitly (the kernel may not
// import from agents), so the map is an LRU capped at MAX_SCOPES: the least
// recently used scope is dropped when a new one would exceed it.

export interface ThreadScopedRegistry<T> {
  /** Returns the instance for this scope key, creating it on first use. */
  get(threadId: string | undefined): T;
}

/** Most scopes kept alive per registry; the least recently used one is evicted beyond this. */
export const MAX_SCOPES = 200;

/**
 * The key a repeat guard / failure counter uses for one tool call: the step scope
 * the worker set (`<turnId>:<stepId>`, prefixed by the thread so ids can never
 * collide across chats), else the bare thread id (tests, scripts).
 */
export function repeatGuardScope(config: { configurable?: Record<string, unknown> } | undefined): string | undefined {
  const threadId = config?.configurable?.["thread_id"] as string | undefined;
  const stepScope = config?.configurable?.["step_scope"] as string | undefined;
  return stepScope ? `${threadId ?? ""}|${stepScope}` : threadId;
}

/** Key used when no thread_id is available (tests, or a config-less call). */
const UNSCOPED_THREAD_KEY = "__unscoped__";

export function makeThreadScopedRegistry<T>(factory: () => T, maxScopes: number = MAX_SCOPES): ThreadScopedRegistry<T> {
  const byThread = new Map<string, T>();
  return {
    get(threadId: string | undefined): T {
      const key = threadId ?? UNSCOPED_THREAD_KEY;
      let instance = byThread.get(key);
      if (instance) {
        byThread.delete(key); // re-insert below: Map order is the LRU order
      } else {
        instance = factory();
        if (byThread.size >= maxScopes) byThread.delete(byThread.keys().next().value as string);
      }
      byThread.set(key, instance);
      return instance;
    },
  };
}
