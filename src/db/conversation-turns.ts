/**
 * FounderOS — conversation_turns: write and read
 * ==============================================
 * The durable log behind "what did I ask you yesterday?". Schema: conversation-turns-schema.ts,
 * migration: drizzle/0043_conversation_turns.sql.
 *
 * WRITE  `recordConversationTurn` inserts one completed turn and does nothing when the
 *        (thread_id, turn_id) pair is already there, so a retried or replayed plan node cannot
 *        duplicate a row.
 * READ   every query takes a thread id and filters on it. There is no way to read across threads
 *        from this module: a guest in an allow-listed group chat runs every non-HITL tool, and the
 *        only thing standing between that guest and the founder's private chat is this filter.
 *
 * Structural types, not the kernel's: db imports nothing above it.
 */

import { and, count, desc, eq, gte, lt, min, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "./client.js";
import { conversationTurns } from "./schema.js";

/** A finished turn as the kernel hands it over (the shape of kernel TurnSummary). */
export interface StoredTurn {
  readonly turn_id: string;
  /** ISO timestamp of the turn. */
  readonly at: string;
  readonly user_input: string;
  readonly goal: string;
  readonly outcome: "replied" | "done" | "failed";
  readonly reply: string;
}

export interface RecalledTurn {
  readonly turn_id: string;
  readonly occurred_at: Date;
  readonly user_input: string;
  readonly goal: string;
  readonly outcome: "replied" | "done" | "failed";
  readonly reply: string;
}

export interface TurnQuery {
  readonly threadId: string;
  /** Inclusive lower bound on when the turn happened. */
  readonly since?: Date;
  /** Exclusive upper bound. */
  readonly until?: Date;
  /** Match turns whose input or reply contains ANY of these; more matched terms rank higher. [] = no topic filter. */
  readonly terms: readonly string[];
  readonly limit: number;
}

export interface TurnPage {
  /** The best `limit` matches: most terms matched first, then most recent. */
  readonly turns: RecalledTurn[];
  /** How many turns matched in all, so the reply can say how many it left out. */
  readonly total: number;
}

export async function recordConversationTurn(threadId: string, turn: StoredTurn): Promise<void> {
  const at = new Date(turn.at);
  await getDb()
    .insert(conversationTurns)
    .values({
      thread_id: threadId,
      turn_id: turn.turn_id,
      occurred_at: Number.isNaN(at.getTime()) ? new Date() : at,
      user_input: turn.user_input,
      goal: turn.goal,
      outcome: turn.outcome,
      reply: turn.reply,
    })
    .onConflictDoNothing({ target: [conversationTurns.thread_id, conversationTurns.turn_id] });
}

/** Escape LIKE wildcards so a term is matched literally. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

export async function findConversationTurns(q: TurnQuery): Promise<TurnPage> {
  const db = getDb();
  const t = conversationTurns;
  const conds: SQL[] = [eq(t.thread_id, q.threadId)];
  if (q.since) conds.push(gte(t.occurred_at, q.since));
  if (q.until) conds.push(lt(t.occurred_at, q.until));

  const termHits = q.terms.map((term) => {
    const p = likePattern(term);
    return sql`(${t.user_input} ILIKE ${p} OR ${t.reply} ILIKE ${p})`;
  });
  const anyTerm = or(...termHits);
  if (anyTerm) conds.push(anyTerm);
  const where = and(...conds);

  const matched = termHits.length > 0 ? sql.join(termHits.map((h) => sql`(CASE WHEN ${h} THEN 1 ELSE 0 END)`), sql` + `) : sql`0`;

  const [rows, totals] = await Promise.all([
    db.select().from(t).where(where).orderBy(desc(matched), desc(t.occurred_at)).limit(q.limit),
    db.select({ n: count() }).from(t).where(where),
  ]);
  return {
    turns: rows.map((r) => ({
      turn_id: r.turn_id,
      occurred_at: r.occurred_at,
      user_input: r.user_input,
      goal: r.goal,
      outcome: r.outcome as RecalledTurn["outcome"],
      reply: r.reply,
    })),
    total: Number(totals[0]?.n ?? 0),
  };
}

/** The oldest saved turn of a thread, or null when nothing is saved yet. */
export async function earliestConversationTurn(threadId: string): Promise<Date | null> {
  const [row] = await getDb()
    .select({ first: min(conversationTurns.occurred_at) })
    .from(conversationTurns)
    .where(eq(conversationTurns.thread_id, threadId));
  return row?.first ? new Date(row.first) : null;
}
