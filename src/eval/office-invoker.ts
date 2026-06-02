/**
 * FounderOS — Live Office Invoker for the Eval Harness
 * =====================================================
 * Bridges the eval runner to the real office graph. Two parts:
 *
 *   extractObservation(messages, hadInterrupt)  — PURE, unit-tested. Reads what
 *     the office did from the message trail: the routed department (from the
 *     supervisor's `transfer_to_<dept>` handoff), the tools that ran, and whether
 *     the run paused for approval.
 *
 *   makeOfficeInvoker(office, getPending)        — the live wiring. Runs each task
 *     on a throwaway thread and observes the result. It NEVER resumes/approves, so
 *     no external action (email/LinkedIn/GitHub write) ever fires during an eval —
 *     side effects only happen after approval, which the eval never gives.
 */

import { HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { Department, Observation, GoldenTask } from "./types.js";
import type { Invoker } from "./runner.js";

const DEPARTMENTS = new Set<Department>([
  "research",
  "comms",
  "engineering",
  "marketing",
  "sales",
  "prospecting",
]);

const TRANSFER_PREFIX = "transfer_to_";

/** Minimal shape of a returned message (tool_calls live on AI messages). */
interface TrailMessage {
  tool_calls?: Array<{ name?: string }>;
}

/**
 * Derive an Observation from the office's returned messages.
 * - route: the LAST `transfer_to_<dept>` handoff that targets a real department
 * - tools: every non-transfer tool call name, de-duplicated, in first-seen order
 */
export function extractObservation(
  messages: TrailMessage[],
  hadInterrupt: boolean,
): Observation {
  let route: Department | null = null;
  const tools: string[] = [];
  const seen = new Set<string>();

  for (const m of messages ?? []) {
    for (const call of m.tool_calls ?? []) {
      const name = call.name;
      if (!name) continue;
      if (name.startsWith(TRANSFER_PREFIX)) {
        const target = name.slice(TRANSFER_PREFIX.length);
        if (DEPARTMENTS.has(target as Department)) {
          route = target as Department; // last one wins
        }
        continue; // never count the handoff as a department tool
      }
      if (!seen.has(name)) {
        seen.add(name);
        tools.push(name);
      }
    }
  }

  return { route, tools, hadInterrupt };
}

/** Office surface the invoker needs (kept narrow for testability). */
interface OfficeLike {
  invoke: (input: unknown, config: RunnableConfig) => Promise<{ messages?: TrailMessage[] }>;
}

/**
 * Build a live Invoker. Each task runs on a unique throwaway thread so eval runs
 * never poison each other or the founder's real conversation history.
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

    const res = await office.invoke({ messages: [new HumanMessage(task.input)] }, config);
    const pending = await getPending(office, config);
    return extractObservation(res.messages ?? [], pending !== null);
  };
}
