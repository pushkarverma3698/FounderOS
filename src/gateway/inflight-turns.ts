/**
 * FounderOS — turns in flight, drained on SIGTERM (AG-037)
 * =========================================================
 * A deploy is `systemctl restart`: SIGTERM, then SIGKILL after TimeoutStopSec. A turn running at that moment
 * used to vanish with no reply, which reads to the founder as "it ignored me".
 *
 *   1. Every kernel turn registers here (`withInflight`) for as long as it runs.
 *   2. On SIGTERM, `drainInFlight` waits up to DRAIN_TIMEOUT_MS for them to finish.
 *   3. Whatever is still running is written to a small ledger file (`recordDroppedTurns`), beside the boot-notice
 *      state, because the database is about to close.
 *   4. The next boot sends one message per dropped turn (`notifyDroppedTurns`) and deletes the entry. A turn is
 *      never replayed: the ask may have had a side effect, so the founder decides.
 *
 * HITL-paused runs are not in flight: the turn returns once the approval card is sent, and the checkpointer
 * resumes it. Resume taps register with `record: false` so a deploy waits for them but never reports them dropped.
 * The ledger sits in ~/.founderos: if it cannot be written the drain still happened and the failure is logged.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "inflight-turns" });

/** How long SIGTERM waits for running turns. `deploy/founderos.service` TimeoutStopSec must stay >= this + 5 s. */
export const DRAIN_TIMEOUT_MS = 25_000;

export interface DroppedTurn {
  turnId: string;
  chatId: string;
  text: string;
}

export interface InflightInfo {
  chatId: string;
  text: string;
  /** false for runs that need a drain but must not be reported as a dropped message (an approval tap). */
  record: boolean;
}

interface Entry extends InflightInfo {
  turnId: string;
}

const inflight = new Map<symbol, Entry>();
let idleWaiters: Array<() => void> = [];

export function inFlightCount(): number {
  return inflight.size;
}

/** Runs `fn` registered as in flight. `setTurnId` swaps the placeholder id for the trace's id once it exists. */
export async function withInflight<T>(info: InflightInfo, fn: (flight: { setTurnId(id: string): void }) => Promise<T>): Promise<T> {
  const key = Symbol("turn");
  const entry: Entry = { ...info, turnId: randomUUID() };
  inflight.set(key, entry);
  try {
    return await fn({
      setTurnId: (id) => {
        entry.turnId = id;
      },
    });
  } finally {
    inflight.delete(key);
    if (inflight.size === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const wake of waiters) wake();
    }
  }
}

/** Waits until nothing is in flight or `timeoutMs` passes. `dropped` is what was still running and should be reported. */
export async function drainInFlight(timeoutMs: number): Promise<{ drained: boolean; dropped: DroppedTurn[] }> {
  if (inflight.size === 0) return { drained: true, dropped: [] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<boolean>((resolve) => idleWaiters.push(() => resolve(true)));
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
  });
  const drained = await Promise.race([idle, expired]);
  clearTimeout(timer);
  if (drained) return { drained: true, dropped: [] };
  const dropped = [...inflight.values()]
    .filter((e) => e.record)
    .map(({ turnId, chatId, text }) => ({ turnId, chatId, text }));
  return { drained: false, dropped };
}

// ── Ledger ────────────────────────────────────────────────────────────────────

function ledgerPath(): string {
  const override = process.env["DROPPED_TURNS_PATH"];
  return override && override.trim().length > 0 ? override : join(homedir(), ".founderos", "dropped-turns.json");
}

async function readLedger(): Promise<DroppedTurn[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(ledgerPath(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is DroppedTurn =>
        typeof t === "object" && t !== null && typeof t.turnId === "string" && typeof t.chatId === "string" && typeof t.text === "string",
    );
  } catch {
    return []; // allow-failopen: no ledger (or an unreadable one) means nothing to announce; the next drop writes a fresh file
  }
}

async function writeLedger(turns: DroppedTurn[]): Promise<void> {
  const file = ledgerPath();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(turns), "utf8");
  await rename(tmp, file);
}

/** Adds turns to the ledger, keyed by turnId (writing the same turn twice leaves one entry). Never throws. */
export async function recordDroppedTurns(turns: DroppedTurn[]): Promise<void> {
  if (turns.length === 0) return;
  try {
    const byId = new Map((await readLedger()).map((t) => [t.turnId, t]));
    for (const t of turns) byId.set(t.turnId, t);
    await writeLedger([...byId.values()]);
  } catch (err) {
    log.error({ err: (err as Error).message, turns: turns.map((t) => t.turnId) }, "Could not record dropped turns — the founder will not be told"); // allow-failopen: shutdown must finish; the error is logged loudly
  }
}

export function droppedTurnMessage(text: string): string {
  return `I restarted while answering "${text.slice(0, 60)}". Send it again.`;
}

/**
 * Boot: one message per ledger entry, then the entry is removed. An entry whose send failed stays for the next
 * boot. Returns how many were sent. Never throws.
 */
export async function notifyDroppedTurns(send: (chatId: string, text: string) => Promise<void>): Promise<number> {
  const pending = await readLedger();
  if (pending.length === 0) return 0;
  const kept: DroppedTurn[] = [];
  let sent = 0;
  for (const turn of pending) {
    try {
      await send(turn.chatId, droppedTurnMessage(turn.text));
      sent += 1;
    } catch (err) {
      log.warn({ turnId: turn.turnId, err: (err as Error).message }, "Could not tell the founder about a dropped turn — will retry next boot"); // allow-failopen: kept in the ledger, retried on the next boot
      kept.push(turn);
    }
  }
  try {
    await writeLedger(kept);
  } catch (err) {
    log.warn({ err: (err as Error).message }, "Could not update the dropped-turn ledger — a notice may repeat on the next boot"); // allow-failopen: the notices already went out
  }
  return sent;
}
