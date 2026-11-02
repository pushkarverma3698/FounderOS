/**
 * FounderOS hub — Google reads (Gmail search, calendar), per account.
 * ===================================================================
 * Read-only by design. Sending mail or creating events acts on the founder's
 * behalf and needs his approval, which exists only in the Telegram gateway
 * (ADR-004, ADR-013). The descriptions say so, so a coding tool routes a send to
 * Telegram instead of retrying here.
 *
 * Accounts are the built-in ones plus any added with `/login google add` in Telegram
 * (src/infra/google-mailboxes.ts), read fresh on every call. Omit `account` to read
 * every account at once, each result labelled.
 */

import { listGoogleMailboxes } from "../infra/google-mailboxes.js";
import { gwsListCalendarEvents, gwsReadEmails } from "../infra/providers/google-gws.js";
import type { ToolResult } from "../tools/index.js";
import { formatError, formatResult, type McpToolResult } from "./brain-tools.js";

const ACCOUNT_SCHEMA = {
  type: "string",
  description: "One Google account: personal, or a name the founder added in Telegram. Omit to read all of them.",
};

export const GOOGLE_TOOLS = [
  {
    name: "gmail_search",
    description:
      "Search the founder's Gmail, read-only, in one account or all of them. Gmail search syntax works " +
      "(from:, to:, subject:, newer_than:7d, is:unread). Sending mail is not available here: ask FounderOS " +
      "in Telegram, which asks the founder to approve.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query, e.g. 'from:client newer_than:14d'" },
        account: ACCOUNT_SCHEMA,
        max_results: { type: "number", description: "Per account, 1-25 (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "calendar_events",
    description:
      "List the founder's calendar events from now on, read-only, in one account or all of them. " +
      "Creating or changing events is not available here: ask FounderOS in Telegram.",
    inputSchema: {
      type: "object",
      properties: {
        account: ACCOUNT_SCHEMA,
        days: { type: "number", description: "How many days ahead, 1-31 (default 7)" },
        max_results: { type: "number", description: "Per account, 1-50 (default 20)" },
      },
    },
  },
];

export interface GoogleDeps {
  readEmails: typeof gwsReadEmails;
  listEvents: typeof gwsListCalendarEvents;
  now: () => Date;
  mailboxes: () => string[];
}

/** Credential alerts are the bot's job; a hub process per session would repeat them. */
const silent = async (): Promise<void> => {};

const defaultDeps: GoogleDeps = {
  readEmails: (input, timeoutMs) => gwsReadEmails(input, timeoutMs, silent),
  listEvents: (input, timeoutMs) => gwsListCalendarEvents(input, timeoutMs, silent),
  now: () => new Date(),
  mailboxes: () => listGoogleMailboxes(),
};

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

/** The accounts a call reads, or an error naming the valid ones. */
function accountsFor(raw: unknown, known: string[]): string[] | string {
  if (raw === undefined || raw === null || raw === "" || raw === "all") return known;
  const key = String(raw).trim().toLowerCase();
  return known.includes(key) ? [key] : `Unknown account "${String(raw)}". Use one of: ${known.join(", ")} (or omit it for all).`;
}

/** One section per account; an error only when every account failed. */
async function perAccount(
  accounts: string[],
  run: (account: string) => Promise<ToolResult>,
): Promise<McpToolResult> {
  const results = await Promise.all(accounts.map(async (a) => [a, await run(a)] as const));
  const text = (r: ToolResult): string => (r.success ? String(r.data) : `Error: ${r.error}`);
  if (results.length === 1) {
    const [, r] = results[0]!;
    return r.success ? formatResult(text(r)) : formatError(text(r));
  }
  const body = results.map(([a, r]) => `## ${a}\n${text(r)}`).join("\n\n");
  return results.every(([, r]) => !r.success) ? formatError(body) : formatResult(body);
}

/** Runs one Google tool. Returns null for a name that is not a Google tool. */
export async function callGoogleTool(
  name: string,
  args: Record<string, unknown>,
  deps: GoogleDeps = defaultDeps,
): Promise<McpToolResult | null> {
  if (name !== "gmail_search" && name !== "calendar_events") return null;
  const accounts = accountsFor(args["account"], deps.mailboxes());
  if (typeof accounts === "string") return formatError(accounts);

  if (name === "gmail_search") {
    const query = String(args["query"] ?? "").trim();
    if (!query) return formatError("gmail_search needs a query, e.g. 'newer_than:7d is:unread'.");
    const max = clamp(args["max_results"], 1, 25, 10);
    return perAccount(accounts, (account_key) => deps.readEmails({ query, max_results: max, account_key }));
  }

  const days = clamp(args["days"], 1, 31, 7);
  const max = clamp(args["max_results"], 1, 50, 20);
  const from = deps.now();
  const to = new Date(from.getTime() + days * 86_400_000);
  return perAccount(accounts, (account_key) =>
    deps.listEvents({ account_key, time_min: from.toISOString(), time_max: to.toISOString(), max_results: max }),
  );
}
