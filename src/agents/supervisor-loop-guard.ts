/**
 * FounderOS — Supervisor Handoff Loop Guard
 * ===========================================
 * Root-cause fix (2026-07-07 audit): the within-department repeat-guard
 * (agent-tools/repeat-guard.ts) only bounds IDENTICAL tool calls inside one
 * department. It never caught the other loop class already documented in
 * MEMORY.md as unfixed — "T35 chained-synthesis LOOPS" — where the SUPERVISOR
 * itself re-transfers to the same department over and over
 * (`transfer_to_engineering` → department does something → back to supervisor
 * → `transfer_to_engineering` again), each hop a full paid LLM call, until
 * GraphRecursionError (OFFICE_RECURSION_LIMIT=40) finally aborts it.
 *
 * This is deterministic, code-level progress tracking — never a prompt
 * instruction the model may ignore (rule #16). `createSupervisor`'s
 * `postModelHook` extension point (a supported library hook, not a
 * rearchitecture) lets us inspect the supervisor's freshly produced handoff
 * decision and rewrite it into an honest stop BEFORE the handoff proceeds,
 * once the same department has already been tried too many times in this
 * window — cheaper and earlier than recursion-limit or budget-cap recovery.
 */

import { AIMessage, ToolMessage, isAIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

/** langgraph-supervisor names every handoff tool `transfer_to_<agent_name>`. */
export const HANDOFF_TOOL_PREFIX = "transfer_to_";

/** Block the (N+1)th handoff to the same department within the message window. */
export const SUPERVISOR_LOOP_HARD_STOP_THRESHOLD = 3;

/** Extract the target department name from a supervisor handoff tool call name. */
export function departmentFromHandoffToolName(toolName: string): string | null {
  if (!toolName.startsWith(HANDOFF_TOOL_PREFIX)) return null;
  const dept = toolName.slice(HANDOFF_TOOL_PREFIX.length);
  return dept.length > 0 ? dept : null;
}

/** Count how many times the supervisor has already handed off to `department` in this window. */
export function countHandoffsToDepartment(messages: BaseMessage[], department: string): number {
  let count = 0;
  for (const m of messages) {
    if (!isAIMessage(m) || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (departmentFromHandoffToolName(tc.name ?? "") === department) count += 1;
    }
  }
  return count;
}

export interface RunawayHandoff {
  department: string;
  priorCount: number;
}

/**
 * True iff the LAST message is a supervisor handoff whose target department has
 * already been tried SUPERVISOR_LOOP_HARD_STOP_THRESHOLD+ times earlier in this
 * window — the supervisor is ping-ponging to the same department without ever
 * finishing. Pure, unit-tested.
 */
export function isRunawayHandoff(messages: BaseMessage[]): RunawayHandoff | null {
  const last = messages[messages.length - 1];
  if (!last || !isAIMessage(last) || !Array.isArray(last.tool_calls) || last.tool_calls.length === 0) {
    return null;
  }
  const priorMessages = messages.slice(0, -1);
  for (const tc of last.tool_calls) {
    const department = departmentFromHandoffToolName(tc.name ?? "");
    if (!department) continue;
    const priorCount = countHandoffsToDepartment(priorMessages, department);
    if (priorCount >= SUPERVISOR_LOOP_HARD_STOP_THRESHOLD) return { department, priorCount };
  }
  return null;
}

export const SUPERVISOR_LOOP_STOP_MESSAGE =
  "🔁 I've routed this to the same department repeatedly without completing it, so I'm stopping here " +
  "instead of looping further and burning cost. Please break the request into smaller, single-step asks " +
  "and I'll handle each one cleanly.";

/**
 * `postModelHook` for createSupervisor (office.ts). Runs after the supervisor's
 * own LLM call, before the handoff tool actually executes. If the just-produced
 * decision is a runaway handoff, replaces it with a terminal, honest answer:
 *   - a ToolMessage closing out every pending tool_call (keeps the message
 *     sequence valid for strict providers — no dangling unanswered tool call), then
 *   - a plain AIMessage (no tool_calls) with the stop notice, which the graph's
 *     own conditional edge (pendingToolCalls.length === 0) naturally routes to END.
 * Returns {} (no state update) when nothing is wrong — the handoff proceeds as normal.
 */
export function supervisorLoopGuardPostModelHook(state: {
  messages: BaseMessage[];
}): { messages: BaseMessage[] } | Record<string, never> {
  const runaway = isRunawayHandoff(state.messages);
  if (!runaway) return {};

  const last = state.messages[state.messages.length - 1] as AIMessage;
  const toolResponses = (last.tool_calls ?? [])
    .filter((tc) => tc.id)
    .map(
      (tc) =>
        new ToolMessage({
          tool_call_id: tc.id!,
          name: tc.name,
          content: SUPERVISOR_LOOP_STOP_MESSAGE,
        }),
    );
  const finalMessage = new AIMessage({ content: SUPERVISOR_LOOP_STOP_MESSAGE });

  return { messages: [...toolResponses, finalMessage] };
}
