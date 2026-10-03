/**
 * FounderOS — boot notices, once per window
 * ==========================================
 * The process sends two things at start: the "back online" card and, while a Google grant is dead, the
 * "sign-in expired" alert. Both went out on every restart, and a day with a dozen deploys is a dozen restarts
 * (2026-10-03). A repeat tells the founder nothing new, so an identical notice is held for a window. A notice
 * whose text changed is a different fact and goes out at once. State is a small file beside the HALT flag;
 * if it cannot be read or written the notice is sent anyway (a duplicate is cheaper than a missed alert).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { logger } from "./logger.js";

const log = logger.child({ module: "boot-notice" });

export type BootNoticeKind = "restart" | "provider-auth";

/** Minimum time between two identical notices of a kind. */
export const BOOT_NOTICE_GAP_MS: Record<BootNoticeKind, number> = {
  restart: 6 * 60 * 60 * 1000,
  "provider-auth": 24 * 60 * 60 * 1000,
};

export type BootNoticeState = Partial<Record<BootNoticeKind, { sentAt: number; fingerprint: string }>>;

function statePath(): string {
  const override = process.env["BOOT_NOTICE_PATH"];
  return override && override.trim().length > 0 ? override : join(homedir(), ".founderos", "boot-notice.json");
}

function fingerprintOf(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** Pure: is this notice due, given what was last sent? */
export function bootNoticeDue(state: BootNoticeState, kind: BootNoticeKind, fingerprint: string, now: number): boolean {
  const last = state[kind];
  if (!last || last.fingerprint !== fingerprint) return true;
  return now - last.sentAt >= BOOT_NOTICE_GAP_MS[kind];
}

async function readState(): Promise<BootNoticeState> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as BootNoticeState;
  } catch {
    return {}; // allow-failopen: no record means send; a duplicate beats a missed alert
  }
}

/** Sends `text` unless an identical notice of this kind went out inside its window. Returns whether it sent. */
export async function sendBootNoticeOnce(
  kind: BootNoticeKind,
  text: string,
  send: (text: string) => Promise<void>,
  now: number = Date.now(),
): Promise<boolean> {
  const fingerprint = fingerprintOf(text);
  const state = await readState();
  if (!bootNoticeDue(state, kind, fingerprint, now)) {
    log.info({ kind }, "Boot notice unchanged inside its window — not re-sent");
    return false;
  }
  await send(text); // a failed send throws before anything is recorded, so the next boot tries again
  try {
    const file = statePath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ ...state, [kind]: { sentAt: now, fingerprint } }), "utf8");
  } catch (err) {
    log.warn({ kind, err: (err as Error).message }, "Could not record the boot notice — it may repeat on the next restart"); // allow-failopen: the notice already went out
  }
  return true;
}
