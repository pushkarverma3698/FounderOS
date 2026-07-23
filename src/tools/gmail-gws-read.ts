/**
 * FounderOS — Gmail read via gws CLI (ADR-028 phase 1)
 */

import { childLogger } from "../infra/logger.js";
import { runGws } from "../infra/gws-runner.js";
import type { ToolResult } from "./index.js";
import {
  emailFromGwsGet,
  extractGwsMessageIds,
  formatEmailList,
  type EmailMessage,
} from "./email-messages.js";

const log = childLogger({ module: "tool:gmail-gws" });

export interface ReadEmailsInput {
  query: string;
  max_results: number;
}

function listParams(query: string, maxResults: number): string {
  return JSON.stringify({ userId: "me", q: query, maxResults });
}

function getParams(messageId: string): string {
  // format: "full" — metadata never carries the body, only the ~100-char
  // snippet, which is why replies used to stop at "Make your journey smoother".
  return JSON.stringify({
    userId: "me",
    id: messageId,
    format: "full",
  });
}

/** Fetch full message metadata for each id (bounded by max_results). */
export async function fetchGwsMessages(
  ids: string[],
  maxResults: number,
  timeoutMs: number,
  gwsProfileDir?: string,
): Promise<{ messages: EmailMessage[]; error?: string }> {
  const messages: EmailMessage[] = [];
  const runOpts = gwsProfileDir ? { gwsProfileDir } : undefined;
  for (const id of ids.slice(0, maxResults)) {
    const got = await runGws(
      ["gmail", "users", "messages", "get", "--params", getParams(id)],
      timeoutMs,
      runOpts,
    );
    if (!got.ok) {
      return { messages, error: got.error };
    }
    const body =
      got.parsed && typeof got.parsed === "object"
        ? ((got.parsed as Record<string, unknown>)["data"] ?? got.parsed)
        : null;
    if (body && typeof body === "object") {
      messages.push(emailFromGwsGet(body as Record<string, unknown>));
    }
  }
  return { messages };
}

export async function readEmailsViaGws(
  input: ReadEmailsInput,
  timeoutMs = 30_000,
): Promise<ToolResult> {
  const listed = await runGws(
    ["gmail", "users", "messages", "list", "--params", listParams(input.query, input.max_results)],
    timeoutMs,
  );
  if (!listed.ok) {
    log.error({ err: listed.error, query: input.query, backend: "gws" }, "Gmail list failed");
    return {
      success: false,
      error: `gws Gmail read failed: ${listed.error}`,
    };
  }

  const ids = extractGwsMessageIds(listed.parsed);
  if (ids.length === 0) {
    return {
      success: true,
      data: formatEmailList([], input.query, input.max_results),
    };
  }

  const { messages, error } = await fetchGwsMessages(ids, input.max_results, timeoutMs);
  if (error && messages.length === 0) {
    return { success: false, error: `gws Gmail read failed: ${error}` };
  }

  log.info({ query: input.query, count: messages.length, backend: "gws" }, "Emails read");
  return {
    success: true,
    data: formatEmailList(messages, input.query, input.max_results),
  };
}
