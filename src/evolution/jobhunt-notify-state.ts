/**
 * Evolution Engine — how often a decision finding may be told to the founder.
 * ===========================================================================
 * Decision findings (`lane-silent`, `candidate-not-acting`) never become issues, so
 * nothing outside this file remembers that the founder was already told. Without
 * memory `candidate-not-acting` (true today: 62 actionable roles, 0 applied) would
 * repeat word for word every morning at 09:30. The 2026-08-21 directive switched
 * off paid crons that produced no acted-on output; an unmemoried free one earns the
 * same fate a slower way, by teaching the founder to swipe the line away.
 *
 * So: a decision is told immediately when it is new (its fingerprint is not in the
 * file), again once DECISION_RENOTIFY_DAYS have passed if it is still true, and not
 * in between. The fingerprint is the finding's own (kind + subject), so the numbers
 * in the evidence moving does not count as news, and a different profile or kind
 * does.
 *
 * The state is a small JSON file under FOUNDEROS_DATA_ROOT, beside the other durable
 * founder data, because `/opt/founderos` is replaced wholesale on every deploy. It
 * is written atomically (temp file, then rename): two overlapping writers may lose
 * an update, which costs a repeated line, but a torn file would cost the state.
 * A missing or damaged file starts EMPTY, with one warning: the failure direction
 * is "tell again", never silence and never a crash.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { dataRoot } from "../core/data-root.js";
import { childLogger } from "../infra/logger.js";
import { computeFingerprint } from "./fingerprint.js";
import type { Finding } from "./types.js";

const log = childLogger({ module: "jobhunt-notify-state" });

const MS_PER_DAY = 86_400_000;

/** Days before a still-true decision is told again. The founder-lesson addition to plan C3. */
export const DECISION_RENOTIFY_DAYS = 7;

const STATE_FILE_NAME = "jobhunt-findings-state.json";

const stateSchema = z.object({
  version: z.literal(1),
  decisions: z.record(
    z.object({
      kind: z.string(),
      subject: z.string(),
      lastNotifiedAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), "not a date"),
    }),
  ),
});

export type NotifyState = z.infer<typeof stateSchema>;

export const EMPTY_NOTIFY_STATE: NotifyState = { version: 1, decisions: {} };

/** `FOUNDEROS_DATA_ROOT/jobhunt-findings-state.json`, resolved at call time so a test can move it. */
export function notifyStatePath(): string {
  return join(dataRoot(), STATE_FILE_NAME);
}

/** The state on disk, or empty (with one warning) when it is missing or cannot be trusted. Never throws. */
export async function loadNotifyState(path: string = notifyStatePath()): Promise<NotifyState> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    log.warn(
      { path, reason: (err as NodeJS.ErrnoException).code ?? (err as Error).message },
      "Jobhunt notify state is missing — starting empty; decision findings will be told once more",
    );
    return EMPTY_NOTIFY_STATE;
  }
  try {
    const parsed = stateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  } catch (err) {
    log.warn(
      { path, err: (err as Error).message },
      "Jobhunt notify state is corrupt — starting empty; decision findings will be told once more",
    );
    return EMPTY_NOTIFY_STATE;
  }
}

/**
 * Write the state atomically. Throws when it cannot: the caller has already sent the
 * message, so it logs and carries on, but a failed save must never look like a save.
 */
export async function saveNotifyState(state: NotifyState, path: string = notifyStatePath()): Promise<void> {
  // A unique temp name per writer: two overlapping saves must not share one, or one
  // could rename the other's half-written file into place.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await rename(tmp, path);
  } catch (err) {
    // allow-failopen: best-effort cleanup of our own temp file; the save's real error is rethrown just below.
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export interface QuietDecision {
  readonly finding: Finding;
  readonly nextReminderAt: Date;
}

/** Split today's decisions into the ones to tell now and the ones already told inside the window. */
export function partitionDecisions(
  findings: readonly Finding[],
  state: NotifyState,
  now: Date,
): { readonly due: Finding[]; readonly quiet: QuietDecision[] } {
  const due: Finding[] = [];
  const quiet: QuietDecision[] = [];
  for (const finding of findings) {
    const told = state.decisions[computeFingerprint(finding)];
    const nextReminderAt = told ? new Date(Date.parse(told.lastNotifiedAt) + DECISION_RENOTIFY_DAYS * MS_PER_DAY) : null;
    if (nextReminderAt && nextReminderAt.getTime() > now.getTime()) quiet.push({ finding, nextReminderAt });
    else due.push(finding);
  }
  return { due, quiet };
}

/**
 * The state after `notified` were told at `now`. Entries older than the window are
 * dropped: they would be told again anyway, and the file must not grow for ever.
 * Entries younger than the window are KEPT even when their finding is absent today,
 * so a finding flickering around its threshold is not re-announced every time it returns.
 */
export function recordNotified(state: NotifyState, notified: readonly Finding[], now: Date): NotifyState {
  const cutoff = now.getTime() - DECISION_RENOTIFY_DAYS * MS_PER_DAY;
  const kept = Object.entries(state.decisions).filter(([, entry]) => Date.parse(entry.lastNotifiedAt) > cutoff);
  const told = notified.map((finding) => [
    computeFingerprint(finding),
    { kind: finding.kind, subject: finding.subject, lastNotifiedAt: now.toISOString() },
  ] as const);
  return { version: 1, decisions: Object.fromEntries([...kept, ...told]) };
}
