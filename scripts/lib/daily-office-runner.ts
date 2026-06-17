/**
 * Shared office task runner for daily stress / live QA scripts.
 * Never approves HITL — external writes stay paused at interrupt.
 */
import { HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { getOffice, getPendingApproval } from "../../src/agents/office.js";
import { OFFICE_RECURSION_LIMIT } from "../../src/core/config.js";
import { markdownToTelegramHtml } from "../../src/gateway/format.js";

export type StressStatus = "PASS" | "HITL" | "BLOCKED" | "FAIL" | "ERROR";

export interface StressTask {
  id: string;
  dept: string;
  input: string;
  expectedTools?: string[];
  expectHITL: boolean;
  expectBlocked?: boolean;
  validate?: (reply: string, toolsCalled: string[]) => string | null;
}

export interface StressResult {
  task: StressTask;
  status: StressStatus;
  toolsCalled: string[];
  replySnippet: string;
  elapsedMs: number;
  error?: string;
  validationError?: string;
  formatIssues: string[];
}

interface TrailMessage {
  _getType?: () => string;
  content?: unknown;
  tool_calls?: Array<{ name?: string }>;
}

interface OfficeLike {
  invoke: (input: unknown, config: RunnableConfig) => Promise<{ messages?: TrailMessage[] }>;
  getState: (config: RunnableConfig) => Promise<unknown>;
}

function validateTelegramHtml(html: string): string[] {
  const ALLOWED = ["b", "i", "u", "s", "code", "pre", "a", "blockquote", "tg-spoiler"];
  const issues: string[] = [];
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z-]+)(?:\s[^>]*)?>/g)) {
    const close = m[1];
    const name = m[2] ?? "";
    if (!ALLOWED.includes(name)) {
      issues.push(`disallowed <${name}>`);
      continue;
    }
    if (close) {
      if (stack[stack.length - 1] === name) stack.pop();
      else issues.push(`unbalanced </${name}>`);
    } else {
      stack.push(name);
    }
  }
  if (stack.length) issues.push(`unclosed <${stack.join(",")}>`);
  if (/<b>\s*<b>|<i>\s*<i>/.test(html)) issues.push("nested identical tags");
  if (/\*\*|^\s*#{1,6}\s|^\|.*\|.*\n\|\s*-/m.test(html)) issues.push("leaked markdown");
  return issues;
}

export async function getStressOffice(): Promise<OfficeLike> {
  return (await getOffice()) as unknown as OfficeLike;
}

export async function runStressTask(
  office: OfficeLike,
  task: StressTask,
  threadId: string,
): Promise<StressResult> {
  const start = Date.now();
  const toolNames: string[] = [];

  const toolCollector = {
    name: "stress-tool-collector",
    handleToolStart(
      _tool: unknown,
      _input: unknown,
      _runId: unknown,
      _parentRunId?: unknown,
      _tags?: unknown,
      _metadata?: unknown,
      runName?: string,
    ): void {
      if (runName) toolNames.push(runName);
    },
  };

  const config: RunnableConfig = {
    configurable: { thread_id: threadId },
    recursionLimit: OFFICE_RECURSION_LIMIT,
    callbacks: [toolCollector],
  };

  try {
    const res = await office.invoke({ messages: [new HumanMessage(task.input)] }, config);
    const elapsed = Date.now() - start;

    const msgs = res.messages ?? [];
    const lastAi = [...msgs]
      .reverse()
      .find(
        (m) =>
          (m._getType?.() ?? "") === "ai" &&
          typeof m.content === "string" &&
          (m.content as string).trim() &&
          !(m.tool_calls && m.tool_calls.length),
      );
    const fullReply = typeof lastAi?.content === "string" ? lastAi.content : "";

    const uniqueTools = [
      ...new Set(toolNames.filter((n) => n && !n.startsWith("transfer_to_"))),
    ];

    const pendingApproval = await getPendingApproval(
      office as unknown as Parameters<typeof getPendingApproval>[0],
      { configurable: { thread_id: threadId } },
    );
    const hadInterrupt = pendingApproval !== null;

    const formatIssues = validateTelegramHtml(markdownToTelegramHtml(fullReply));

    let status: StressStatus;
    let validationError: string | undefined;

    if (task.expectBlocked) {
      const vErr = task.validate?.(fullReply, uniqueTools) ?? null;
      status = vErr ? "FAIL" : "BLOCKED";
      validationError = vErr ?? undefined;
    } else if (hadInterrupt && task.expectHITL) {
      status = "HITL";
      if (task.expectedTools?.length) {
        const missing = task.expectedTools.find((t) => !uniqueTools.includes(t));
        if (missing) {
          status = "FAIL";
          validationError = `Expected tool '${missing}' was not called`;
        }
      }
    } else if (hadInterrupt && !task.expectHITL) {
      status = "FAIL";
      validationError = "Unexpected HITL interrupt fired";
    } else if (!hadInterrupt && task.expectHITL) {
      status = "FAIL";
      validationError = "Expected HITL interrupt but none fired";
    } else {
      const vErr = task.validate?.(fullReply, uniqueTools) ?? null;
      if (vErr) {
        status = "FAIL";
        validationError = vErr;
      } else {
        status = "PASS";
      }
    }

    return {
      task,
      status,
      toolsCalled: uniqueTools,
      replySnippet: fullReply.slice(0, 200).replace(/\n/g, " "),
      elapsedMs: elapsed,
      formatIssues,
      validationError,
    };
  } catch (err: unknown) {
    return {
      task,
      status: "ERROR",
      toolsCalled: [],
      replySnippet: "",
      elapsedMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
      formatIssues: [],
    };
  }
}

/** PASS, HITL, and BLOCKED count as success for daily stress (no external writes). */
export function stressResultOk(r: StressResult): boolean {
  return r.status === "PASS" || r.status === "HITL" || r.status === "BLOCKED";
}
