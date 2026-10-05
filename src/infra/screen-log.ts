/**
 * FounderOS — the screen log: what the founder has seen in Telegram
 * ================================================================
 * The planner replays its own turns and nothing else. Five other senders put text on the founder's
 * screen: the VPS daemons (curl), typed slash commands, planned commands, tools that send, and the
 * nightly journey scripts. On 2026-10-04 agent-dispatch posted "#76/PR #79 … blocked" and, a minute
 * later, "what repository are these PRs on?" got a guess, because the planner had never seen the alert.
 *
 * Every successful send now appends one JSON line to ~/.claude/screen.jsonl (the bot and the daemons
 * run as the same user, so they share the file):
 *
 *   {"ts":"<ISO>","chat":"<id>","src":"pr-brain","text":"…","mid":42}    a message (mid = Telegram id)
 *   {"ts":"<ISO>","chat":"<id>","src":"bot","mid":42,"del":true}          that message was deleted
 *
 * Writers: installScreenCapture (a grammy transformer, both Bot instances), tg_screen_log in
 * deploy/lib/tg-quiet.sh (every daemon), appendScreenEntry (journey scripts). Reader: readScreen, for
 * the planner (src/kernel/screen.ts). Writing is best-effort and happens after the send succeeded: a
 * lost line costs one answer some context, a thrown one would cost the founder the message itself.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, open, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Transformer } from "grammy";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "screen-log" });

export interface ScreenEntry {
  /** ISO time the message was sent (or last edited). */
  readonly ts: string;
  /** Telegram chat id, as a string. */
  readonly chat: string;
  /** Who sent it: "bot", "pr-brain", "agent-dispatch", "journey-where", … */
  readonly src: string;
  readonly text: string;
  /** Telegram message id when known: a later line with the same id is an edit of this message. */
  readonly mid?: number;
}

/** One line as written: a message, or a tombstone (`del`) for a deleted message id. */
export interface ScreenWrite {
  readonly chat: string;
  readonly src: string;
  readonly text?: string;
  readonly mid?: number;
  readonly del?: true;
}

/** Rotate to `<file>.1` past this size. deploy/lib/tg-quiet.sh uses the same number. */
export const SCREEN_LOG_MAX_BYTES = 1_048_576;
/** Text kept per line; the planner shows far less (kernel/screen.ts), this only bounds the file. */
export const SCREEN_TEXT_MAX_CHARS = 4_000;
export const SCREEN_WINDOW_MS = 12 * 3_600_000;
export const SCREEN_MAX_ENTRIES = 12;
/** Only the end of the file is read: 12 hours of sends fit many times over. */
const TAIL_BYTES = 256 * 1024;

/**
 * ~/.claude/screen.jsonl, or FOUNDEROS_SCREEN_LOG. Null under vitest unless set: a test that drives a
 * real grammy Api must not append to the developer's (or CI's) home directory.
 */
export function screenLogFile(): string | null {
  const override = process.env["FOUNDEROS_SCREEN_LOG"];
  if (override) return override;
  if (process.env["VITEST"]) return null;
  return join(homedir(), ".claude", "screen.jsonl");
}

const quiet = new AsyncLocalStorage<true>();

/**
 * Run `fn` with screen capture off. The kernel's final reply goes out this way: it is already in the
 * conversation history the planner replays, and logging it too would show the planner every answer twice.
 */
export function screenQuiet<T>(fn: () => Promise<T>): Promise<T> {
  return quiet.run(true, fn);
}

/** Append one line. Never throws: the message it describes has already been delivered. */
export async function appendScreenEntry(
  entry: ScreenWrite,
  file: string | null = screenLogFile(),
  now: Date = new Date(),
): Promise<void> {
  if (!file) return;
  const line = {
    ts: now.toISOString(),
    chat: entry.chat,
    src: entry.src,
    ...(entry.text === undefined ? {} : { text: entry.text.slice(0, SCREEN_TEXT_MAX_CHARS) }),
    ...(entry.mid === undefined ? {} : { mid: entry.mid }),
    ...(entry.del ? { del: true } : {}),
  };
  try {
    await mkdir(dirname(file), { recursive: true });
    const size = await stat(file).then((s) => s.size, () => 0);
    if (size > SCREEN_LOG_MAX_BYTES) await rename(file, `${file}.1`);
    await appendFile(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (err) {
    log.warn({ err: String(err), src: entry.src }, "Screen log write failed — the planner will not see this message"); // allow-failopen: the message is already on the founder's screen; failing here would only lose the send's result
  }
}

/** The last TAIL_BYTES of a file, without its first (possibly cut) line. "" when the file is missing. */
async function tail(file: string): Promise<string> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await handle.read(buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally {
    await handle.close();
  }
}

function parseLine(raw: string): (ScreenWrite & { ts: string }) | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o["ts"] !== "string" || Number.isNaN(Date.parse(o["ts"]))) return null;
  if (typeof o["chat"] !== "string" || typeof o["src"] !== "string") return null;
  const mid = typeof o["mid"] === "number" && Number.isInteger(o["mid"]) ? o["mid"] : undefined;
  if (o["del"] === true) return mid === undefined ? null : { ts: o["ts"], chat: o["chat"], src: o["src"], mid, del: true };
  if (typeof o["text"] !== "string") return null;
  return { ts: o["ts"], chat: o["chat"], src: o["src"], text: o["text"], ...(mid === undefined ? {} : { mid }) };
}

/**
 * What `chat` has seen in the last `windowMs`, oldest first, at most `max` entries. An edit replaces
 * the earlier text of the same message id, a delete removes it, and lines that do not parse are
 * skipped. Throws only when the file exists and cannot be read.
 */
export async function readScreen(
  chat: string,
  now: Date,
  opts: { file?: string | null; windowMs?: number; max?: number } = {},
): Promise<ScreenEntry[]> {
  const file = opts.file === undefined ? screenLogFile() : opts.file;
  if (!file) return [];
  const since = now.getTime() - (opts.windowMs ?? SCREEN_WINDOW_MS);
  let text = await tail(file);
  // Right after a rotation the live file holds almost nothing: read the rotated one first.
  if (text.length < TAIL_BYTES) text = `${await tail(`${file}.1`)}\n${text}`;

  const byKey = new Map<string, ScreenEntry>();
  let anon = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const e = parseLine(raw);
    if (!e || e.chat !== chat) continue;
    const t = Date.parse(e.ts);
    if (t < since || t > now.getTime() + 60_000) continue;
    const key = e.mid === undefined ? `anon:${anon++}` : `mid:${e.mid}`;
    if (e.del) {
      byKey.delete(key);
      continue;
    }
    // An edit moves the message to its edit time, so the list stays in the order of the times shown.
    byKey.delete(key);
    byKey.set(key, { ts: e.ts, chat: e.chat, src: e.src, text: e.text!, ...(e.mid === undefined ? {} : { mid: e.mid }) });
  }
  return [...byKey.values()].slice(-(opts.max ?? SCREEN_MAX_ENTRIES));
}

const TEXT_METHODS = new Set(["sendMessage", "editMessageText"]);
const CAPTION_METHODS = new Set(["sendPhoto", "sendDocument", "sendVideo", "sendAnimation", "editMessageCaption"]);

/** The screen line one successful Bot API call implies, or null when it put nothing on a chat screen. */
export function screenEntryFromCall(method: string, payload: unknown, result: unknown, src: string): ScreenWrite | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const chatId = p["chat_id"];
  if (typeof chatId !== "string" && typeof chatId !== "number") return null; // inline messages have no chat
  const chat = String(chatId);
  const fromResult =
    typeof result === "object" && result !== null ? (result as Record<string, unknown>)["message_id"] : undefined;
  const midRaw = p["message_id"] ?? fromResult;
  const mid = typeof midRaw === "number" ? midRaw : undefined;
  if (method === "deleteMessage") return mid === undefined ? null : { chat, src, mid, del: true };
  const text = TEXT_METHODS.has(method) ? p["text"] : CAPTION_METHODS.has(method) ? p["caption"] : undefined;
  if (typeof text !== "string" || text === "") return null;
  return { chat, src, text, ...(mid === undefined ? {} : { mid }) };
}

interface TransformableApi {
  config?: { use?: (t: Transformer) => void };
}

/** Log every successful send on this Bot API, except those inside screenQuiet. */
export function installScreenCapture(api: TransformableApi, src: string, file: string | null = screenLogFile()): void {
  if (!file || typeof api?.config?.use !== "function") return; // a mocked grammy has no transformer hook
  const capture: Transformer = async (prev, method, payload, signal) => {
    const res = await prev(method, payload, signal);
    if (res.ok && !quiet.getStore()) {
      const entry = screenEntryFromCall(method, payload, res.result, src);
      if (entry) await appendScreenEntry(entry, file);
    }
    return res;
  };
  api.config.use(capture);
}
