/**
 * FounderOS — mem0 Episodic Memory Integration
 * =============================================
 * Wraps the mem0 REST API (https://api.mem0.ai) to provide semantic memory
 * for the personal agent. When MEM0_API_KEY is set, every recorded event is
 * also pushed to mem0 cloud so future searches benefit from semantic retrieval
 * instead of keyword-only ILIKE. Falls back silently if the API is unavailable
 * (fail-open — the Postgres episodic_memory table is always the primary store).
 *
 * Usage:
 *   const mem0 = getMem0Client();          // null if MEM0_API_KEY not set
 *   await mem0?.add(userId, messages);     // fire-and-forget; errors are logged
 *   const hits = await mem0?.search(userId, query);
 */

import { childLogger } from "./logger.js";

const log = childLogger({ module: "infra:mem0" });

const BASE_URL = "https://api.mem0.ai/v1";

export interface Mem0Memory {
  id: string;
  memory: string;
  score?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface Mem0Message {
  role: "user" | "assistant" | "system";
  content: string;
}

export class Mem0Client {
  private readonly apiKey: string;
  readonly userId: string;

  constructor(apiKey: string, userId: string) {
    this.apiKey = apiKey;
    this.userId = userId;
  }

  private headers() {
    return {
      "Authorization": `Token ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Add messages (conversation turn) to mem0 memory for semantic recall later.
   * Fire-and-forget safe — caller should not await in the hot path.
   */
  async add(messages: Mem0Message[], metadata?: Record<string, unknown>): Promise<void> {
    try {
      const res = await fetch(`${BASE_URL}/memories/`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ messages, user_id: this.userId, metadata }),
      });
      if (!res.ok) {
        log.warn({ status: res.status }, "mem0 add failed");
      }
    } catch (err) {
      log.warn({ err }, "mem0 add error (non-fatal)");
    }
  }

  /**
   * Semantic search over this user's mem0 memory store.
   * Returns [] on error so callers can safely spread the result.
   */
  async search(query: string, limit = 5): Promise<Mem0Memory[]> {
    try {
      const params = new URLSearchParams({ query, user_id: this.userId, limit: String(limit) });
      const res = await fetch(`${BASE_URL}/memories/search/?${params}`, {
        headers: this.headers(),
      });
      if (!res.ok) {
        log.warn({ status: res.status }, "mem0 search failed");
        return [];
      }
      const data = (await res.json()) as { results?: Mem0Memory[] };
      return data.results ?? [];
    } catch (err) {
      log.warn({ err }, "mem0 search error (non-fatal)");
      return [];
    }
  }

  /** Retrieve all memories for this user (admin/debug). */
  async list(limit = 20): Promise<Mem0Memory[]> {
    try {
      const params = new URLSearchParams({ user_id: this.userId, limit: String(limit) });
      const res = await fetch(`${BASE_URL}/memories/?${params}`, {
        headers: this.headers(),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { results?: Mem0Memory[] };
      return data.results ?? [];
    } catch {
      return [];
    }
  }
}

let _instance: Mem0Client | null | undefined = undefined; // undefined = not yet resolved

/**
 * Returns the singleton Mem0Client when MEM0_API_KEY is set, null otherwise.
 * Callers check: `const mem0 = getMem0Client(); if (mem0) await mem0.add(...)`.
 */
export function getMem0Client(): Mem0Client | null {
  if (_instance !== undefined) return _instance;
  const key = process.env["MEM0_API_KEY"];
  const userId = process.env["MEM0_USER_ID"] || process.env["FOUNDER_TENANT"] || "founder";
  _instance = key ? new Mem0Client(key, userId) : null;
  if (_instance) log.info({ userId }, "mem0 client initialised");
  return _instance;
}
