/**
 * Who may read `visibility: founder` brain rows (AG-027, audit F3). Pure.
 * The Mac capture writes founder-only rows; a group chat that the founder allow-listed must not retrieve them.
 */
import type { RagFilter } from "./rag-search.js";

/** The founder's own chat: the kernel names its thread `<tenant>:<chat id>` (src/gateway/kernel-run.ts threadIdFor). */
export function isFounderThread(threadId: string, tenant: string, founderChatId: string): boolean {
  return threadId !== "" && threadId === `${tenant}:${founderChatId}`;
}

/** Filter fragment for a caller: empty for the founder DM, otherwise exclude founder-only rows. No thread = not the founder DM. */
export function visibilityFilter(threadId: string, tenant: string, founderChatId: string): Pick<RagFilter, "excludeFounderOnly"> {
  return isFounderThread(threadId, tenant, founderChatId) ? {} : { excludeFounderOnly: true };
}
