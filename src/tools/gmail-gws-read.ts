/**
 * FounderOS — Gmail read via gws CLI (ADR-028 phase 1)
 */

import { runGws } from "../infra/gws-runner.js";
import {
  emailFromGwsGet,
  type EmailMessage,
} from "./email-messages.js";



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
