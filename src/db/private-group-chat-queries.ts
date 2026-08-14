/**
 * FounderOS — Private Group Chat Message Queries
 * ================================================
 * Type-safe data access helpers for the private_group_chat_messages table.
 * All queries go through Drizzle's query builder — no raw SQL.
 *
 * Pattern: verbs + domain — insertMessage, getMessagesByUsername, getRecentMessages
 */

import { and, desc, eq, gte, lte } from "drizzle-orm";
import { getDb } from "./client.js";
import {
  privateGroupChatMessages,
  type NewPrivateGroupChatMessage,
  type PrivateGroupChatMessage,
} from "./schema.js";

// ── Write ─────────────────────────────────────────────────────────────────────

/** Persist a single incoming group chat message. Returns the inserted row id. */
export async function insertGroupChatMessage(
  data: Omit<NewPrivateGroupChatMessage, "id">,
): Promise<string> {
  const db = getDb();
  const [row] = await db
    .insert(privateGroupChatMessages)
    .values(data)
    .returning({ id: privateGroupChatMessages.id });
  if (!row) throw new Error("insertGroupChatMessage: insert returned no rows");
  return row.id;
}

// ── Read ──────────────────────────────────────────────────────────────────────

/** Fetch the most recent `limit` messages, newest first. */
export async function getRecentGroupChatMessages(
  limit = 50,
): Promise<PrivateGroupChatMessage[]> {
  const db = getDb();
  return db
    .select()
    .from(privateGroupChatMessages)
    .orderBy(desc(privateGroupChatMessages.timestamp))
    .limit(limit);
}

/** Fetch all messages sent by a specific username, newest first. */
export async function getMessagesByUsername(
  username: string,
  limit = 100,
): Promise<PrivateGroupChatMessage[]> {
  const db = getDb();
  return db
    .select()
    .from(privateGroupChatMessages)
    .where(eq(privateGroupChatMessages.username, username))
    .orderBy(desc(privateGroupChatMessages.timestamp))
    .limit(limit);
}

/** Fetch a single message by its primary key. Returns null if not found. */
export async function getGroupChatMessageById(
  id: string,
): Promise<PrivateGroupChatMessage | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(privateGroupChatMessages)
    .where(eq(privateGroupChatMessages.id, id))
    .limit(1);
  return row ?? null;
}

/** Fetch messages within an inclusive time window, newest first. */
export async function getGroupChatMessagesByTimeRange(
  from: Date,
  to: Date,
  limit = 200,
): Promise<PrivateGroupChatMessage[]> {
  const db = getDb();
  return db
    .select()
    .from(privateGroupChatMessages)
    .where(
      and(
        gte(privateGroupChatMessages.timestamp, from),
        lte(privateGroupChatMessages.timestamp, to),
      ),
    )
    .orderBy(desc(privateGroupChatMessages.timestamp))
    .limit(limit);
}

// ── Delete ────────────────────────────────────────────────────────────────────

/** Hard-delete a message by id. Returns true if a row was deleted. */
export async function deleteGroupChatMessage(id: string): Promise<boolean> {
  const db = getDb();
  const result = await db
    .delete(privateGroupChatMessages)
    .where(eq(privateGroupChatMessages.id, id))
    .returning({ id: privateGroupChatMessages.id });
  return result.length > 0;
}
