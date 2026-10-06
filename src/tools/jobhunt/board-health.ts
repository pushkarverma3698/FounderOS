/**
 * FounderOS — the persisted dead-board record
 * ===========================================
 * The free lane asks every board in the registry a question every thirty minutes,
 * and about thirty of them never answer it: a rotated token 404s forever. Measured
 * on prod 2026-09-29, 670 sweeps in seven days each stored "30–33 board(s) failed:
 * greenhouse HTTP 404 ×16–18; ashby HTTP 404 ×3–4; lever HTTP 404 ×3…" — the same
 * dead boards, asked again and reported again, 48 times a day. A line that never
 * changes is a line nobody reads, and it drowned the failures that do change.
 *
 * THE RULE. A board that answers HTTP 404 on DEAD_BOARD_STREAK consecutive sweeps
 * (ten: five hours at the 30-minute cadence) stops being asked. It is asked ONCE MORE
 * every seven days, so a revived board comes back without anyone editing the registry,
 * and the sweep says "skipped N dead boards" instead of listing them.
 *
 * WHAT COUNTS. A permanent-looking answer: a 4xx the host means as "no" (404, 403, 422,
 * 400 ...) or a 200 that is not JSON (board-failure.ts has the rule and the 2026-10-05 prod
 * numbers behind it; until then only 404 counted, so 5-6 boards failed every sweep for ever).
 * A 429 is a rate limit, a 5xx is a host having a bad hour, a timeout is a network: none of
 * them says the board is gone, and treating one as dead is how a healthy employer silently
 * leaves the registry (see free-ats-source.ts, RETRYABLE_STATUSES, which draws the same line).
 * A neutral answer neither advances nor resets a streak. A 200 removes the board from the record.
 *
 * THE PLATFORM GUARD. A failure only counts on a platform where at least one board
 * answered in the same sweep, and not where most of its boards failed permanently at once
 * (platformsInOutage). If Ashby moves its API, every ashby board 404s at once
 * — that is a broken adapter, and counting it would mark the whole platform dead in
 * five hours and silence it for a week. (A platform whose every polled board is
 * really dead is never skipped either; it keeps being asked, which costs nothing.)
 *
 * WHY A FILE, NOT A MAP. `fix/jobhunt-pipeline-audit-fixes` kept its counters in a
 * process-lifetime Map, so every deploy started every dead board over, and it never
 * asked a skipped board again. The record lives in `${FOUNDEROS_DATA_ROOT}/board-health.json`,
 * beside the CVs and the discovered-boards CSV: `/opt/founderos` is replaced on every
 * deploy, `/opt/founderos-data` is not.
 *
 * TWO KINDS OF OVERLAP, TWO DEFENCES.
 *   · Inside one process two sweeps can overlap (a slow sweep against the next cron
 *     tick). The read-modify-write runs on a promise chain, so neither loses the
 *     other's increments.
 *   · Across processes (a script on the VPS while the service runs) nothing can lock.
 *     The file is written to a temp file of its OWN name and renamed over the target,
 *     so a reader sees the old file or the new one, never half of either. A lost
 *     increment costs one more 404 before a skip; a torn file would cost the record.
 *
 * A MISSING, UNREADABLE OR CORRUPT FILE STARTS EMPTY, and warns once per process. The
 * failure direction is "every board is asked", never "boards are skipped on a guess",
 * and never a crashed sweep. The same goes for a write that fails: the sweep carries on
 * and says so, and the dead boards are simply asked again next time, as they were before.
 *
 * The decisions are pure functions over a record and a clock (`splitBySkip`,
 * `nextBoardHealth`); everything that touches the disk is below them.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { z } from "zod";

import { dataRoot } from "../../core/data-root.js";
import { childLogger } from "../../infra/logger.js";
import { failureReason, platformsInOutage, type FailureFacts } from "./board-failure.js";

const log = childLogger({ module: "jobhunt:board-health" });

/**
 * Consecutive permanent-looking failures after which a board stops being asked. Ten sweeps,
 * half an hour apart (FREE_SWEEP_CRON), is five hours: long enough that one bad hour at a host
 * (a CDN serving an HTML maintenance page, a WAF 403) cannot fake it, short enough that the
 * noise ends the same working day. Fewer would let a single outage window retire live boards.
 */
export const DEAD_BOARD_STREAK = 10;

/** How long a skipped board sits out before it is asked once more: a week. */
export const DEAD_BOARD_REPROBE_MS = 7 * 24 * 60 * 60 * 1000;

/** The record's file name, under the data root. */
export const BOARD_HEALTH_FILE = "board-health.json";

/** Just enough of a board to key it; a full `FreeBoard` is assignable. */
export interface BoardRef {
  readonly ats: string;
  readonly token: string;
}

/**
 * One failing board. Healthy boards have NO entry, so `jq 'length'` on the file counts
 * the boards currently failing; the ones with `streak >= DEAD_BOARD_STREAK` are the
 * skipped ones.
 *
 * `reason` is why it last failed permanently ("HTTP 403", "HTML instead of JSON"), so the
 * sweep can say why a board was retired; an entry written before it existed was a 404.
 *
 * `last_probe_at` is the last time the board gave a DEFINITIVE answer, which is what the
 * seven-day re-probe clock runs from. An inconclusive answer (429, 5xx) leaves it alone,
 * so a re-probe that met a rate limit is tried again on the next sweep rather than pushed
 * out another week.
 */
export interface BoardHealthEntry {
  readonly streak: number;
  readonly first_failed_at: string;
  readonly last_probe_at: string;
  readonly reason?: string;
}

/** `"<ats>:<token>"` → its streak. */
export type BoardHealth = Readonly<Record<string, BoardHealthEntry>>;

/** What one board's poll came back with, reduced to the two facts this module needs. */
export interface BoardOutcome extends FailureFacts {
  readonly board: BoardRef;
  readonly ok: boolean;
  /** The HTTP status of a failed poll, when there was one (FailureFacts). Absent for a timeout or a parse error. */
}

/** Everything the record needs from the outside world, so a test can inject both. */
export interface BoardHealthDeps {
  readonly root: string;
  readonly now: () => Date;
}

/** The production wiring: the real data root (src/core/data-root.ts) and the real clock. Only the cron entrypoint uses this. */
export function boardHealthDeps(env: Readonly<Record<string, string | undefined>> = process.env): BoardHealthDeps {
  return { root: dataRoot(env), now: () => new Date() };
}

export const boardHealthPath = (root: string): string => join(root, BOARD_HEALTH_FILE);

export const boardKey = (board: BoardRef): string => `${board.ats}:${board.token}`;

// ── pure decisions ────────────────────────────────────────────────────────────

/**
 * Whether a board is inside its skip window right now.
 *
 * An unreadable `last_probe_at` and one in the future both fail the comparison, so a
 * damaged timestamp means "ask the board" — the direction that cannot hide a live one.
 */
export function isSkipped(entry: BoardHealthEntry | undefined, now: Date): boolean {
  if (entry === undefined || entry.streak < DEAD_BOARD_STREAK) return false;
  const sinceProbe = now.getTime() - Date.parse(entry.last_probe_at);
  return sinceProbe >= 0 && sinceProbe < DEAD_BOARD_REPROBE_MS;
}

/** Which boards this sweep asks and which sit it out. The caller's own objects come back untouched. */
export function splitBySkip<T extends BoardRef>(
  boards: readonly T[],
  health: BoardHealth,
  now: Date,
): { poll: T[]; skipped: T[] } {
  const poll: T[] = [];
  const skipped: T[] = [];
  for (const board of boards) {
    (isSkipped(health[boardKey(board)], now) ? skipped : poll).push(board);
  }
  return { poll, skipped };
}

/**
 * What a sweep's answers do to the record. Returns a new record; the input is never touched.
 *
 * Boards that were not polled this sweep (skipped ones) are not in `outcomes` and keep
 * their entry exactly as it was.
 */
export function nextBoardHealth(
  health: BoardHealth,
  outcomes: readonly BoardOutcome[],
  now: Date,
): BoardHealth {
  // The platform guard: see the file header.
  const answered = new Set(outcomes.filter((o) => o.ok).map((o) => o.board.ats));
  const outage = platformsInOutage(outcomes);
  const stamp = now.toISOString();
  const next: Record<string, BoardHealthEntry> = { ...health };

  for (const outcome of outcomes) {
    const key = boardKey(outcome.board);
    if (outcome.ok) {
      delete next[key];
    } else if (answered.has(outcome.board.ats) && !outage.has(outcome.board.ats)) {
      const reason = failureReason(outcome);
      if (reason === undefined) continue;
      const prior = next[key];
      next[key] = {
        streak: (prior?.streak ?? 0) + 1,
        first_failed_at: prior?.first_failed_at ?? stamp,
        last_probe_at: stamp,
        reason,
      };
    }
  }
  return next;
}

// ── the sweep summary ─────────────────────────────────────────────────────────

/**
 * Append the skip count to a sweep's failure summary as its own clause.
 *
 * `summary` is `summariseFailures`' text and is passed through untouched, because
 * `job_ingest_runs.error` has a reader that parses it: "3 board(s) failed: greenhouse
 * HTTP 404 ×2; ashby HTTP 500 ×1 | skipped 27 dead boards". Always "boards", even for one:
 * the wording is fixed so a reader can match it.
 */
export function appendSkippedDead(summary: string, skipped: number): string {
  if (skipped <= 0) return summary;
  const clause = `skipped ${skipped} dead boards`;
  return summary === "" ? clause : `${summary} | ${clause}`;
}

const SKIPPED_CLAUSE = /^(?:(.*) \| )?skipped (\d+) dead boards$/s;

/** The inverse of `appendSkippedDead`, for whoever reads `job_ingest_runs.error` back. */
export function splitSweepError(error: string | null | undefined): { failures: string; skippedDead: number } {
  if (!error) return { failures: "", skippedDead: 0 };
  const match = SKIPPED_CLAUSE.exec(error);
  if (!match) return { failures: error, skippedDead: 0 };
  return { failures: match[1] ?? "", skippedDead: Number(match[2]) };
}

// ── the file ──────────────────────────────────────────────────────────────────

const entrySchema = z.object({
  streak: z.number().int().nonnegative(),
  first_failed_at: z.string(),
  last_probe_at: z.string(),
  reason: z.string().optional(),
});
const healthSchema = z.record(z.string(), entrySchema);

/** Warnings this process has already given, so a sweep that runs 48 times a day does not repeat one. */
const warned = new Set<string>();
function warnOnce(key: string, fields: Record<string, unknown>, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(fields, message);
}

type Parsed = { readonly ok: true; readonly health: BoardHealth } | { readonly ok: false; readonly reason: string };

function parseBoardHealth(text: string): Parsed {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  const parsed = healthSchema.safeParse(json);
  if (parsed.success) return { ok: true, health: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, reason: `${issue?.path.join(".") || "root"}: ${issue?.message ?? "unexpected shape"}` };
}

/**
 * Read the record. Never throws, never returns a guess: any problem with the file is
 * an empty record (every board is asked), warned once per process.
 */
export async function loadBoardHealth(root: string): Promise<BoardHealth> {
  const path = boardHealthPath(root);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    // allow-failopen: no record must mean "ask every board", not a crashed sweep. Warned once.
    const code = (err as NodeJS.ErrnoException).code;
    warnOnce(
      `read:${path}`,
      { path, code },
      code === "ENOENT"
        ? `${BOARD_HEALTH_FILE} does not exist yet at ${path} — starting with no skipped boards. Normal on the first ` +
            `sweep after a deploy; the file is created when a board first answers 404.`
        : `Could not read ${path} (${code ?? "unknown error"}) — starting with no skipped boards, so every board is ` +
            `asked this sweep. Fix: check the file and that FOUNDEROS_DATA_ROOT is readable by the service.`,
    );
    return {};
  }

  const parsed = parseBoardHealth(text);
  if (parsed.ok) return parsed.health;
  warnOnce(
    `corrupt:${path}`,
    { path, reason: parsed.reason },
    `${path} is corrupt (${parsed.reason}) — starting with no skipped boards, so every board is asked this sweep. ` +
      `The next sweep that changes the record rewrites it.`,
  );
  return {};
}

/** Canonical text for a record: sorted keys, so two equal records are byte-identical and diff cleanly. */
function serialise(health: BoardHealth): string {
  const sorted = Object.fromEntries(Object.entries(health).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

/**
 * Write the record atomically: a temp file, then `rename` over the target.
 *
 * The temp file's name is unique per write (pid + uuid), NOT a fixed `<file>.tmp`: two
 * writers sharing one temp name interleave into it, and the rename then publishes the
 * interleaving. Throws on failure, and removes its own temp file first.
 */
export async function saveBoardHealth(root: string, health: BoardHealth): Promise<void> {
  const target = boardHealthPath(root);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  try {
    await writeFile(temp, serialise(health), "utf8");
    await rename(temp, target);
  } catch (err) {
    // allow-failopen: best-effort cleanup of this write's own temp file; the real error is rethrown just below.
    await unlink(temp).catch(() => undefined);
    throw err;
  }
}

/** Runs read-modify-writes one at a time within this process. */
let queue: Promise<unknown> = Promise.resolve();
function inOrder<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  // allow-failopen: `queue` only sequences tasks; each caller gets its own task's outcome from `run`, so one failure must not poison the next.
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Read the record and split the registry into the boards to ask and the boards that sit
 * this sweep out. Never throws. `health` is the record as read, for the caller's summary.
 */
export async function planBoardPolls<T extends BoardRef>(
  boards: readonly T[],
  deps: BoardHealthDeps,
): Promise<{ poll: T[]; skipped: T[]; health: BoardHealth }> {
  const health = await loadBoardHealth(deps.root);
  const plan = splitBySkip(boards, health, deps.now());
  const reprobing = plan.poll.filter((b) => (health[boardKey(b)]?.streak ?? 0) >= DEAD_BOARD_STREAK).length;
  if (plan.skipped.length > 0 || reprobing > 0) {
    log.info(
      { skipped: plan.skipped.length, reprobing, polled: plan.poll.length },
      "Dead boards sat out this sweep; those due a weekly re-probe were asked again",
    );
  }
  return { ...plan, health };
}

/** The record after a sweep, and the boards that crossed the threshold in it ("<ats>/<token>"). */
export interface RecordedOutcomes {
  readonly health: BoardHealth;
  readonly newlyRetired: readonly string[];
}

/**
 * Fold a sweep's answers into the record and write it. Never throws; resolves to undefined when
 * the record could not be written, so the caller falls back to the record it read.
 *
 * The record is RE-READ inside the queue rather than carried over from `planBoardPolls`,
 * so an overlapping sweep's increments are composed, not overwritten. Nothing is written
 * when nothing changed, which is the steady state once the dead boards are skipped.
 */
export async function recordBoardOutcomes(
  outcomes: readonly BoardOutcome[],
  deps: BoardHealthDeps,
): Promise<RecordedOutcomes | undefined> {
  const path = boardHealthPath(deps.root);
  try {
    return await inOrder(async () => {
      const current = await loadBoardHealth(deps.root);
      const next = nextBoardHealth(current, outcomes, deps.now());
      if (serialise(current) === serialise(next)) return { health: next, newlyRetired: [] };
      await saveBoardHealth(deps.root, next);
      return { health: next, newlyRetired: announceNewlyDead(current, next) };
    });
  } catch (err) {
    // allow-failopen: a record that cannot be written costs only the skip (the dead boards are asked again, as before); it must not cost the sweep.
    warnOnce(
      `write:${path}`,
      { path, err: (err as Error).message },
      `Could not persist ${BOARD_HEALTH_FILE} at ${path} — dead boards keep being asked every sweep. ` +
        `Fix: make FOUNDEROS_DATA_ROOT (default /opt/founderos-data) writable by the service user.`,
    );
    return undefined;
  }
}

/** One log line per board, the moment it crosses the threshold: the trail that says which token to remove. */
function announceNewlyDead(before: BoardHealth, after: BoardHealth): string[] {
  const newly: string[] = [];
  for (const [key, entry] of Object.entries(after)) {
    if (entry.streak >= DEAD_BOARD_STREAK && (before[key]?.streak ?? 0) < DEAD_BOARD_STREAK) {
      newly.push(key.replace(":", "/"));
      log.warn(
        { board: key, since: entry.first_failed_at, reason: entry.reason },
        `Board ${key} failed (${entry.reason ?? "HTTP 404"}) on ${entry.streak} consecutive sweeps and is marked dead — ` +
          `skipped from now on, asked again once a week. If it stays dead, remove it from docs/strategy/data/free-ats-boards.csv.`,
      );
    }
  }
  return newly;
}
