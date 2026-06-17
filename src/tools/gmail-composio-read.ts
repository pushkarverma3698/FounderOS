/**
 * FounderOS — Gmail read via Composio (legacy backend)
 */

import { childLogger } from "../infra/logger.js";
import {
  executeComposioAction,
  getComposioApiKey,
  getGmailConnectionId,
  getGmailUserId,
} from "../infra/composio.js";
import type { ToolResult } from "./index.js";
import { extractComposioMessages, formatEmailList } from "./email-messages.js";

const log = childLogger({ module: "tool:gmail-composio" });

export interface ReadEmailsInput {
  query: string;
  max_results: number;
}

export async function readEmailsViaComposio(input: ReadEmailsInput): Promise<ToolResult> {
  if (!getComposioApiKey()) {
    return {
      success: false,
      error: "COMPOSIO_API_KEY not configured. Add it to .env to enable Gmail access via Composio.",
    };
  }

  try {
    const result = (await executeComposioAction(
      "GMAIL_FETCH_EMAILS",
      { query: input.query, max_results: input.max_results, verbose: false },
      getGmailConnectionId(),
      getGmailUserId(),
    )) as Record<string, unknown>;

    const messages = extractComposioMessages(result);
    log.info({ query: input.query, count: messages.length, backend: "composio" }, "Emails read");
    return {
      success: true,
      data: formatEmailList(messages, input.query, input.max_results),
    };
  } catch (err) {
    const message = (err as Error).message;
    log.error({ err: message, query: input.query, backend: "composio" }, "Email read failed");
    return { success: false, error: `Composio Gmail read failed: ${message}` };
  }
}
