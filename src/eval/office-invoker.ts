/**
 * FounderOS — Live Office Invoker for the Eval Harness
 * =====================================================
 * Bridges the eval runner to the real office graph.
 *
 * Observability note (live-test finding, 2026-06-03): langgraph-supervisor
 * defaults to outputMode "last_message", so a sub-agent's INTERNAL tool calls
 * never appear in the top-level message trail — only the supervisor's own
 * handoff does. So we observe the two things from two sources:
 *   - route: the message trail (the supervisor's `transfer_to_<dept>` call)
 *   - tools: a LangChain callback (handleToolStart fires for every tool, even
 *            inside sub-agents) — production behaviour is unchanged, the callback
 *            is eval-only instrumentation.
 *
 * Pure helpers (routeFromMessages, collectDeptTools, extractObservation) are
 * unit-tested without an LLM. makeOfficeInvoker is the live wiring; it observes
 * each run up to the approval pause and NEVER approves, so no external action
 * (email / LinkedIn / GitHub write) ever fires during an eval.
 */

import type { RunnableConfig } from "@langchain/core/runnables";
import { buildOfficeInput, preRouteDepartment, resolveForcedTool } from "../gateway/pre-router.js";
import { FORCE_TOOL_CHOICE_ENABLED } from "../core/config.js";
import type { Department, Observation, GoldenTask } from "./types.js";
import type { Invoker } from "./runner.js";

const DEPARTMENTS = new Set<Department>([
  "admin",
  "research",
  "comms",
  "engineering",
  "marketing",
  "sales",
  "personal",
  "jobhunt",
]);

const TRANSFER_PREFIX = "transfer_to_";

/** Minimal shape of a returned message (tool_calls live on AI messages). */
interface TrailMessage {
  tool_calls?: Array<{ name?: string }>;
}

/**
 * Derive the routed department from the message trail: the LAST
 * `transfer_to_<dept>` handoff that targets a real department.
 */
export function routeFromMessages(messages: TrailMessage[]): Department | null {
  let route: Department | null = null;
  for (const m of messages ?? []) {
    for (const call of m.tool_calls ?? []) {
      const name = call.name;
      if (!name || !name.startsWith(TRANSFER_PREFIX)) continue;
      const target = name.slice(TRANSFER_PREFIX.length);
      if (DEPARTMENTS.has(target as Department)) route = target as Department;
    }
  }
  return route;
}

/**
 * Reduce a stream of observed tool-start names into the department tools used:
 * de-duplicated, first-seen order, with handoff tools (transfer_*) excluded.
 */
export function collectDeptTools(toolNames: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of toolNames ?? []) {
    if (!name || name.startsWith(TRANSFER_PREFIX)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** Assemble an Observation from the trail (route), callback names (tools), and HITL state. */
export function extractObservation(
  messages: TrailMessage[],
  toolNames: string[],
  hadInterrupt: boolean,
): Observation {
  return {
    route: routeFromMessages(messages),
    tools: collectDeptTools(toolNames),
    hadInterrupt,
  };
}

/** Office surface the invoker needs (kept narrow for testability). */
interface OfficeLike {
  invoke: (input: unknown, config: RunnableConfig) => Promise<{ messages?: TrailMessage[] }>;
}

/**
 * Build a live Invoker. Each task runs on a unique throwaway thread so eval runs
 * never poison each other or the founder's real conversation history. A
 * tool-collecting callback records every tool that starts (including inside
 * sub-agents), which is the only reliable way to observe tool usage under
 * outputMode "last_message".
 *
 * @param office     compiled office graph (from getOffice())
 * @param getPending (office, config) => pending approval | null  (getPendingApproval)
 */
export function makeOfficeInvoker(
  office: OfficeLike,
  getPending: (office: OfficeLike, config: RunnableConfig) => Promise<unknown>,
): Invoker {
  return async (task: GoldenTask): Promise<Observation> => {
    const threadId = `eval:${task.id}:${Date.now()}`;
    const config: RunnableConfig = { configurable: { thread_id: threadId } };

    const toolNames: string[] = [];
    const toolCollector = {
      name: "eval-tool-collector",
      // handleToolStart fires before the tool body runs (so even gated tools that
      // interrupt() are captured). runName is the tool's name (e.g. "send_email").
      handleToolStart: (
        _tool: unknown,
        _input: unknown,
        _runId: unknown,
        _parentRunId?: unknown,
        _tags?: unknown,
        _metadata?: unknown,
        runName?: string,
      ): void => {
        if (runName) toolNames.push(runName);
      },
    };

    if (!task.input || (typeof task.input === "string" && task.input.trim().length === 0)) {
      throw new Error(`Task input is empty: ${JSON.stringify(task)}`);
    }

    // Use the SAME input builder as the Telegram gateway so the eval exercises
    // the real production routing path, including the deterministic pre-router
    // hint (CLAUDE.md rule #19).
    //
    // Mirror office-run.ts:959-970: when native tool_choice forcing is on, inject
    // the SAME `configurable.forced_tool` the production gateway does, so the eval
    // actually exercises forceToolChoiceMiddleware. Without this the eval silently
    // diverges from prod and its numbers prove nothing about forcing (Gate B gap).
    const preRoutedDept = FORCE_TOOL_CHOICE_ENABLED ? preRouteDepartment(task.input) : null;
    const forcedTool = preRoutedDept ? resolveForcedTool(preRoutedDept, task.input) : null;
    const res = await office.invoke(
      { messages: buildOfficeInput(task.input) },
      {
        configurable: {
          thread_id: threadId,
          ...(forcedTool ? { forced_tool: forcedTool } : {}),
        },
        callbacks: [toolCollector],
      },
    );
    const pending = await getPending(office, config);
    return extractObservation(res.messages ?? [], toolNames, pending !== null);
  };
}
