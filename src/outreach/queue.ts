/**
 * Delayed execution queue — simulates human pacing before a connection send.
 * SaaS phase: swap InMemoryOutreachQueue for Postgres + worker consumer.
 *
 * ADR-009 note: production FounderOS today is draft-only for connections;
 * this queue stages payloads for a future HITL-gated or founder-approved executor.
 */

import { randomInt } from "node:crypto";
import type { OutreachQueuePayload } from "./contracts.js";
import { OutreachQueuePayloadSchema } from "./contracts.js";

export interface EnqueueOutreachInput {
  profile_id: string;
  message: string;
  account_id: string;
  /** Base delay before send (ms). Jitter added for human pacing. */
  base_delay_ms?: number;
}

export interface OutreachQueueEntry extends OutreachQueuePayload {
  enqueued_at: string;
  status: "pending" | "dispatched" | "cancelled";
}

export interface OutreachQueue {
  enqueue(input: EnqueueOutreachInput): OutreachQueueEntry;
  get(id: string): OutreachQueueEntry | undefined;
  listPending(accountId?: string): OutreachQueueEntry[];
}

const DEFAULT_BASE_DELAY_MS = 45 * 60_000; // 45 minutes
const JITTER_MS: [number, number] = [5 * 60_000, 25 * 60_000]; // +5–25 min

function pacingJitter(): number {
  return randomInt(JITTER_MS[0], JITTER_MS[1] + 1);
}

export function createInMemoryOutreachQueue(): OutreachQueue & { _entries: Map<string, OutreachQueueEntry> } {
  const entries = new Map<string, OutreachQueueEntry>();

  return {
    _entries: entries,
    enqueue(input: EnqueueOutreachInput): OutreachQueueEntry {
      const queue_id = `outreach_${Date.now()}_${randomInt(1000, 9999)}`;
      const jitter = pacingJitter();
      const base = input.base_delay_ms ?? DEFAULT_BASE_DELAY_MS;
      const scheduled = new Date(Date.now() + base + jitter);

      const payload = OutreachQueuePayloadSchema.parse({
        queue_id,
        profile_id: input.profile_id,
        message: input.message.trim(),
        scheduled_at: scheduled.toISOString(),
        pacing_jitter_ms: jitter,
        account_id: input.account_id,
      });

      const entry: OutreachQueueEntry = {
        ...payload,
        enqueued_at: new Date().toISOString(),
        status: "pending",
      };
      entries.set(queue_id, entry);
      return entry;
    },
    get(id: string) {
      return entries.get(id);
    },
    listPending(accountId?: string) {
      return [...entries.values()].filter(
        (e) => e.status === "pending" && (!accountId || e.account_id === accountId),
      );
    },
  };
}
