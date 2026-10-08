/**
 * FounderOS gateway — the Postgres reads behind the planner's in-flight block (AG-055, kernel/in-flight.ts).
 * One read per source, each scoped to the asking thread or its chat. Wired in kernel-boot.ts.
 */
import { latestConversationTurns } from "../db/conversation-turns.js";
import { listPendingApprovalCards, listRemindersDue } from "../db/queries.js";
import { chatIdFromThreadId } from "../infra/telegram-send.js";
import type { InFlightSource } from "../kernel/index.js";

export function buildInFlightSource(): InFlightSource {
  return {
    pendingApprovals: (q) => listPendingApprovalCards(q.threadId, q.now),
    remindersDue: async (q) => {
      const chat = chatIdFromThreadId(q.threadId);
      return chat ? listRemindersDue(q.tenantId, chat, q.now, q.until) : [];
    },
    recentTurns: (q) => latestConversationTurns(q.threadId, q.limit),
  };
}
