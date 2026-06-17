/**
 * FounderOS — Shared email message types + formatting
 * ====================================================
 * Pure helpers shared by Composio and gws Gmail read backends.
 */

export interface EmailMessage {
  messageId?: string;
  threadId?: string;
  sender?: string;
  subject?: string;
  messageText?: string;
  messageTimestamp?: string;
}

export function normalizeEmailMessage(raw: Record<string, unknown>): EmailMessage {
  return {
    messageId: String(raw["messageId"] ?? raw["id"] ?? raw["message_id"] ?? ""),
    threadId: String(raw["threadId"] ?? raw["thread_id"] ?? ""),
    sender: String(raw["sender"] ?? raw["from"] ?? raw["senderEmail"] ?? "unknown sender"),
    subject: String(raw["subject"] ?? "(no subject)"),
    messageText: String(raw["messageText"] ?? raw["snippet"] ?? raw["body"] ?? raw["preview"] ?? ""),
    messageTimestamp: String(raw["messageTimestamp"] ?? raw["date"] ?? raw["internalDate"] ?? ""),
  };
}

/** Extract messages from a Composio GMAIL_FETCH_EMAILS response. */
export function extractComposioMessages(result: Record<string, unknown>): EmailMessage[] {
  const data = result["data"];
  if (Array.isArray(data)) {
    return data.map((m) => normalizeEmailMessage(m as Record<string, unknown>));
  }
  if (data && typeof data === "object") {
    const nested = data as { messages?: unknown[] };
    if (Array.isArray(nested.messages)) {
      return nested.messages.map((m) => normalizeEmailMessage(m as Record<string, unknown>));
    }
  }
  if (Array.isArray(result["messages"])) {
    return (result["messages"] as unknown[]).map((m) =>
      normalizeEmailMessage(m as Record<string, unknown>),
    );
  }
  return [];
}

/** Read a Gmail API header value from a gws messages.get payload. */
export function headerFromGwsPayload(payload: unknown, name: string): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const headers = (payload as { headers?: Array<{ name?: string; value?: string }> }).headers;
  if (!Array.isArray(headers)) return undefined;
  const hit = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return hit?.value;
}

/** Map a gws gmail.users.messages.get JSON body to EmailMessage. */
export function emailFromGwsGet(raw: Record<string, unknown>): EmailMessage {
  const payload = raw["payload"];
  return {
    messageId: String(raw["id"] ?? ""),
    threadId: String(raw["threadId"] ?? raw["thread_id"] ?? ""),
    sender: headerFromGwsPayload(payload, "From") ?? "unknown sender",
    subject: headerFromGwsPayload(payload, "Subject") ?? "(no subject)",
    messageText: String(raw["snippet"] ?? ""),
    messageTimestamp: headerFromGwsPayload(payload, "Date") ?? "",
  };
}

/** Extract message id list from gws gmail.users.messages.list response. */
export function extractGwsMessageIds(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as Record<string, unknown>;
  const data = root["data"] ?? root;
  if (!data || typeof data !== "object") return [];
  const messages = (data as { messages?: Array<{ id?: string }> }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function formatEmailList(messages: EmailMessage[], query: string, maxResults: number): string {
  if (messages.length === 0) {
    return `No emails found matching "${query}". Inbox may be empty or the query returned no results.`;
  }
  return messages
    .slice(0, maxResults)
    .map((m, i) => {
      const from = m.sender ?? "unknown sender";
      const subject = m.subject ?? "(no subject)";
      const body = m.messageText?.slice(0, 200) ?? "";
      const date = m.messageTimestamp ?? "";
      return `${i + 1}. From: ${from}${date ? ` · ${date}` : ""}\n   Subject: ${subject}${body ? `\n   ${body}` : ""}`;
    })
    .join("\n\n");
}
