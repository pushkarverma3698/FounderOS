/**
 * Shared office task runner for daily stress / live QA scripts.
 * Never approves HITL — external writes stay paused at interrupt.
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import { getOffice, getPendingApproval } from "../../src/agents/office.js";
import { OFFICE_RECURSION_LIMIT } from "../../src/core/config.js";
import { buildKnowledgeGroundingRefusal } from "../../src/gateway/execution-guard.js";
import { markdownToTelegramHtml } from "../../src/gateway/format.js";
import {
  buildGuardRetryMessages,
  finalReply,
  needsExecutionGuardRetry,
  sliceFreshMessages,
} from "../../src/gateway/office-run.js";
import { buildOfficeInput } from "../../src/gateway/pre-router.js";
import type { OfficeMessageLike } from "../../src/gateway/execution-guard.js";

export type StressStatus = "PASS" | "HITL" | "BLOCKED" | "FAIL" | "ERROR";

export interface StressTask {
  id: string;
  dept: string;
  input: string;
  expectedTools?: string[];
  expectHITL: boolean;
  expectBlocked?: boolean;
  /** Run the same input twice on one thread (stale-reply regression). */
  repeatOnSameThread?: boolean;
  validate?: (reply: string, toolsCalled: string[], messages: OfficeMessageLike[]) => string | null;
}

export interface StressResult {
  task: StressTask;
  status: StressStatus;
  toolsCalled: string[];
  freshMessages: OfficeMessageLike[];
  replySnippet: string;
  fullReply: string;
  elapsedMs: number;
  error?: string;
  validationError?: string;
  formatIssues: string[];
  guardKind?: "shell" | "linkedin" | "inbox" | "memory" | "knowledge";
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
    recursionLimit: Math.max(OFFICE_RECURSION_LIMIT, 40),
    callbacks: [toolCollector],
  };

  try {
    const beforeState = (await office.getState(config).catch(() => null)) as {
      values?: { messages?: TrailMessage[] };
    } | null;
    const baseLen = (beforeState?.values?.messages ?? []).length;

    const res = await office.invoke({ messages: buildOfficeInput(task.input) }, config);
    const elapsed = Date.now() - start;

    let freshMessages = sliceFreshMessages(
      (res.messages ?? []) as Parameters<typeof sliceFreshMessages>[0],
      baseLen,
    ) as OfficeMessageLike[];
    let fullReply = finalReply({ messages: freshMessages });
    let guardBlocked = false;
    let guardKind = needsExecutionGuardRetry(task.input, freshMessages, fullReply) ?? undefined;

    if (guardKind) {
      const retryMessages = buildGuardRetryMessages(guardKind, task.input);
      const retryBefore = (await office.getState(config).catch(() => null)) as {
        values?: { messages?: TrailMessage[] };
      } | null;
      const retryBaseLen = (retryBefore?.values?.messages ?? []).length;
      const retryRes = await office.invoke({ messages: retryMessages }, config);
      const retryPending = await getPendingApproval(
        office as unknown as Parameters<typeof getPendingApproval>[0],
        { configurable: { thread_id: threadId } },
      );
      if (retryPending) {
        const uniqueTools = [
          ...new Set(toolNames.filter((n) => n && !n.startsWith("transfer_to_"))),
        ];
        const formatIssues = validateTelegramHtml(markdownToTelegramHtml(fullReply));
        let status: StressStatus;
        let validationError: string | undefined;
        if (task.expectHITL) {
          status = "HITL";
        } else {
          status = "FAIL";
          validationError = "Unexpected HITL interrupt fired";
        }
        return {
          task,
          status,
          toolsCalled: uniqueTools,
          freshMessages,
          replySnippet: fullReply.slice(0, 200).replace(/\n/g, " "),
          fullReply,
          elapsedMs: elapsed,
          formatIssues,
          validationError,
          guardKind,
        };
      }
      freshMessages = sliceFreshMessages(
        (retryRes.messages ?? []) as Parameters<typeof sliceFreshMessages>[0],
        retryBaseLen,
      ) as OfficeMessageLike[];
      fullReply = finalReply({ messages: freshMessages });
    }

    const stillUngrounded = needsExecutionGuardRetry(task.input, freshMessages, fullReply);
    if (stillUngrounded === "knowledge" || stillUngrounded === "memory") {
      fullReply = buildKnowledgeGroundingRefusal();
      guardBlocked = true;
      guardKind = stillUngrounded;
    }

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
      const vErr = task.validate?.(fullReply, uniqueTools, freshMessages) ?? null;
      status = vErr ? "FAIL" : "BLOCKED";
      validationError = vErr ?? undefined;
    } else if (guardBlocked) {
      const vErr = task.validate?.(fullReply, uniqueTools, freshMessages) ?? null;
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
      const vErr = task.validate?.(fullReply, uniqueTools, freshMessages) ?? null;
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
      freshMessages,
      replySnippet: fullReply.slice(0, 200).replace(/\n/g, " "),
      fullReply,
      elapsedMs: elapsed,
      formatIssues,
      validationError,
      guardKind,
    };
  } catch (err: unknown) {
    return {
      task,
      status: "ERROR",
      toolsCalled: [],
      freshMessages: [],
      replySnippet: "",
      fullReply: "",
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

/** Run task twice on one thread — catches stale checkpoint regurgitation. */
export async function runStressTaskRepeat(
  office: OfficeLike,
  task: StressTask,
  threadId: string,
): Promise<{ first: StressResult; second: StressResult }> {
  const first = await runStressTask(office, task, threadId);
  const second = await runStressTask(office, task, threadId);
  return { first, second };
}
