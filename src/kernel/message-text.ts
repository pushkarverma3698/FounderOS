/**
 * FounderOS v3 kernel — model message-content extraction.
 * =========================================================
 * Providers return `content` as a plain string OR an array of typed parts —
 * and which one can change under a rolling model alias (2026-07-11:
 * gemini-flash-latest started emitting parts arrays, and the kernel's
 * string-only extraction discarded honest finalizes as "" — turns d211fb74 /
 * 8c7e098f died with "Worker did not finalize with JSON"). Every kernel node
 * that reads model output goes through this ONE pure function.
 */
import { jsonrepair } from "jsonrepair";

/** Extract the text of a model message's content, accepting both provider shapes. */
export function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("");
}

/** Parse a model's JSON answer: strip a ``` fence, then JSON.parse, then jsonrepair; null when neither parses. */
export function tryParseJson(text: string): unknown | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    try {
      return JSON.parse(jsonrepair(cleaned));
    } catch {
      return null;
    }
  }
}
