/**
 * Diagnostics agent-tools — the kernel observing its own runtime.
 *
 * Deliberately a NEW file rather than more of engineering.ts, which is already
 * 550 lines against a 400-line budget (baselined in
 * governance/architecture-baseline.json — the ratchet lets it shrink, not grow).
 *
 * read_logs is read-only and therefore NOT in HITL_GATED_TOOLS. Putting an
 * approval card in front of self-diagnosis is what makes an agent guess instead
 * of look — which is exactly the 2026-09-15 fabrication this tool exists to end.
 * See src/tools/read-logs.ts for that incident.
 */

import { tool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { z } from "zod";
import { readLogsTool } from "../../tools/read-logs.js";
import { toolFailure } from "../tool-result.js";
import { makeRepeatGuard, makeThreadScopedRegistry } from "./repeat-guard.js";

/**
 * Same loop breaker github_read carries, for the same reason: a weak model
 * re-reads a SUCCESSFUL log window instead of answering from it. Measured
 * 2026-09-16 on the founder's "read founderOs logs" turn — four read_logs calls
 * in one turn, two of them after the result was already in context. Each one
 * re-feeds a 200-line journal window to the planner, so the thrash is expensive
 * in exactly the turns that are already close to the watchdog.
 *
 * Per-thread, never module-scope: the graph is compiled once and tools are bound
 * at that time, so a shared guard would let one chat block another (rule #20).
 */
const _readLogsRepeatGuards = makeThreadScopedRegistry(() => makeRepeatGuard());

function threadIdFrom(config: RunnableConfig | undefined): string | undefined {
  return config?.configurable?.["thread_id"] as string | undefined;
}

export const readLogs = tool(
  async ({ since, until, level, grep, limit, unit }, config) => {
    if (
      _readLogsRepeatGuards
        .get(threadIdFrom(config))
        .shouldBlock("read_logs", { since, until, level, grep, limit, unit })
    ) {
      return (
        `You have already called read_logs with these exact arguments and the log lines are ` +
        `in the conversation above. Do NOT call read_logs again with the same window — either ` +
        `answer the founder now from what you read, or change the window (different 'since', ` +
        `'level' or 'grep') if you genuinely need different evidence.`
      );
    }

    const res = await readLogsTool.execute({
      ...(since ? { since } : {}),
      ...(until ? { until } : {}),
      ...(level ? { level } : {}),
      ...(grep ? { grep } : {}),
      ...(limit !== undefined && limit !== null ? { limit } : {}),
      ...(unit ? { unit } : {}),
    });

    if (!res.success) {
      // The stage is deliberately not "external_api": journalctl is a local
      // instrument, and mislabelling it would send a reader looking upstream.
      const stage = /allowlist/i.test(res.error ?? "") ? "validation" : "unknown";
      return toolFailure(
        stage,
        `${res.error ?? "read_logs failed for an unknown reason."} ` +
          `You have NO log evidence for this window. Report that you could not read the logs — ` +
          `do not substitute another tool and do not describe runtime behaviour you did not observe.`,
      );
    }

    return JSON.stringify(res.data, null, 2);
  },
  {
    name: "read_logs",
    description: readLogsTool.description,
    schema: z.object({
      since: z.string().optional().nullable().describe("Window start, journalctl syntax: '1 hour ago', '2 days ago', '2026-09-15'. Default '1 hour ago'."),
      until: z.string().optional().nullable().describe("Window end, same syntax."),
      level: z.enum(["all", "warn", "error"]).optional().nullable().describe("'error' = pino level >= 50, 'warn' >= 40."),
      grep: z.string().optional().nullable().describe("Case-insensitive substring filter (module, turnId, message text)."),
      limit: z.number().optional().nullable().describe("Max lines returned."),
      unit: z.string().optional().nullable().describe("systemd unit; allowlisted."),
    }),
  },
);
