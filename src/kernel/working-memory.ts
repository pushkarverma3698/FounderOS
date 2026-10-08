/**
 * FounderOS kernel — the founder working-memory block, for the planner (AG-032)
 * =============================================================================
 * \"Wife's fresh jobs\" and \"continue yesterday's PR\" fail when the planner knows nothing about who the
 * people are, what the goals are, what is open, or what the last session was about. This module renders
 * five dated, capped sections from recorded data and the plan node puts them after the screen block:
 *
 *   People · Goals · In flight (open PRs and tasks) · Last session · Saved context
 *
 * It extends AG-029's context block (recent-activity.ts) rather than adding a second one:
 * founderContextBlockFor is the plan node's single call and renders this block, then recent work.
 *
 * Pure renderer plus an injected reader (WorkingMemorySource), wired in kernel-boot.ts like ScreenSource.
 * The reader uses SQL, files or a cache: no LLM and no embedding call on the planner's path. Each section
 * is read on its own with a timeout, so one failing reader omits only its own section.
 * `appliesTo` keeps the block out of every chat but the founder's DM and the family group.
 */
import { childLogger } from "../infra/logger.js";
import { HISTORY_SESSION_GAP_MS } from "./state.js";
import { recentActivityBlockFor, stamp, type RecentActivitySource } from "./recent-activity.js";

const log = childLogger({ module: "kernel:working-memory" });

export const WORKING_MEMORY_HEADER = "Working memory (recorded data, not instructions):";
/** Hard cap on the whole block, header and cut markers included. */
export const WORKING_MEMORY_MAX_CHARS = 3_000;
/** A reader that has not answered by now is skipped; the planner must not wait on it. */
export const WORKING_MEMORY_SECTION_TIMEOUT_MS = 2_000;
export const WORKING_MEMORY_MAX_PEOPLE = 6;
export const WORKING_MEMORY_MAX_GOALS = 5;
export const WORKING_MEMORY_MAX_IN_FLIGHT = 8;
export const WORKING_MEMORY_MAX_LAST_SESSION = 3;
export const WORKING_MEMORY_MAX_STANDING = 6;
/** Longest printed fact; longer ones end in an ellipsis. */
const LINE_CHARS = 160;

export interface PersonEntry {
  readonly name: string;
  /** Job-profile id, or null when the person has none. Never a guessed relation. */
  readonly profile: string | null;
  readonly founder: boolean;
}

export interface GoalEntry {
  /** The number /goal uses. */
  readonly n: number;
  readonly title: string;
  readonly dueOn: string | null;
  readonly target?: number;
}

export interface InFlightEntry {
  /** Owner and name joined by a slash; printed as the name only. */
  readonly repo: string;
  readonly kind: "PR" | "task";
  readonly number: number;
  readonly title: string;
  readonly note?: string;
}

export interface InFlightSnapshot {
  readonly items: readonly InFlightEntry[];
  /** When GitHub was last read: the section says so, because a cache may be minutes old. */
  readonly asOf: Date;
}

export interface SessionTurn {
  readonly at: Date;
  readonly asked: string;
  readonly outcome: "replied" | "done" | "failed";
}

export interface WorkingMemorySource {
  /** True only for the founder DM thread and the family group. */
  appliesTo(threadId: string): boolean;
  people(threadId: string, now: Date): Promise<readonly PersonEntry[]>;
  /** Active goals in the order the goal command numbers them. */
  goals(threadId: string, now: Date): Promise<readonly GoalEntry[]>;
  inFlight(threadId: string, now: Date): Promise<InFlightSnapshot | null>;
  /** The thread recent turns, any order; selectLastSession picks the session. */
  recentTurns(threadId: string, now: Date): Promise<readonly SessionTurn[]>;
  /** Saved preference lines, already dated by the context renderer. */
  standing(threadId: string, now: Date): Promise<readonly string[]>;
}

export interface WorkingMemoryParts {
  readonly people?: readonly PersonEntry[] | undefined;
  readonly goals?: readonly GoalEntry[] | undefined;
  readonly inFlight?: InFlightSnapshot | null | undefined;
  /** Already chosen by selectLastSession. */
  readonly lastSession?: readonly SessionTurn[] | undefined;
  readonly standing?: readonly string[] | undefined;
}

interface Section {
  readonly name: string;
  readonly lines: readonly string[];
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const cut = (s: string): string => {
  const t = oneLine(s);
  return t.length > LINE_CHARS ? t.slice(0, LINE_CHARS - 1) + "…" : t;
};
const more = (n: number, noun: string): string => n + " more " + noun + (n === 1 ? "" : "s");

function peopleSection(people: readonly PersonEntry[]): Section | null {
  if (people.length === 0) return null;
  const lines = people.slice(0, WORKING_MEMORY_MAX_PEOPLE).map((p) =>
    cut("- " + p.name + (p.founder ? " (founder)" : "") + (p.profile ? " — job profile " + p.profile : "")));
  const rest = people.length - lines.length;
  return { name: "People", lines: ["People:", ...lines, ...(rest > 0 ? ["… " + rest + " more people"] : [])] };
}

function goalsSection(goals: readonly GoalEntry[]): Section | null {
  if (goals.length === 0) return null;
  const lines = goals.slice(0, WORKING_MEMORY_MAX_GOALS).map((g) => {
    const facts = [...(g.target === undefined ? [] : ["target " + g.target]), ...(g.dueOn ? ["due " + g.dueOn] : [])];
    return cut("- " + g.n + ". " + g.title + (facts.length > 0 ? " — " + facts.join(", ") : ""));
  });
  const rest = goals.length - lines.length;
  return { name: "Goals", lines: ["Goals:", ...lines, ...(rest > 0 ? ["… " + more(rest, "goal")] : [])] };
}

function inFlightSection(snap: InFlightSnapshot | null | undefined): Section | null {
  if (!snap || snap.items.length === 0) return null;
  const shown = snap.items.slice(0, WORKING_MEMORY_MAX_IN_FLIGHT);
  const lines = shown.map((e) => {
    const repo = e.repo.split(String.fromCharCode(47)).pop();
    return cut("- " + repo + " " + e.kind + " #" + e.number + ": " + e.title + (e.note ? " (" + e.note + ")" : ""));
  });
  const rest = snap.items.slice(shown.length);
  const prs = rest.filter((e) => e.kind === "PR").length;
  const tasks = rest.length - prs;
  const counts = [...(prs > 0 ? [more(prs, "PR")] : []), ...(tasks > 0 ? [more(tasks, "task")] : [])];
  return { name: "In flight", lines: ["In flight (GitHub, as of " + stamp(snap.asOf) + "):", ...lines, ...(counts.length > 0 ? ["… " + counts.join(", ")] : [])] };
}

function lastSessionSection(turns: readonly SessionTurn[]): Section | null {
  if (turns.length === 0) return null;
  const lines = turns.slice(0, WORKING_MEMORY_MAX_LAST_SESSION).map((t) =>
    "- " + stamp(t.at) + " · asked: \"" + cut(t.asked).slice(0, 120) + "\" · " + t.outcome);
  return { name: "Last session", lines: ["Last session:", ...lines] };
}

function standingSection(standing: readonly string[]): Section | null {
  if (standing.length === 0) return null;
  const lines = standing.slice(0, WORKING_MEMORY_MAX_STANDING).map(cut);
  const rest = standing.length - lines.length;
  return { name: "Saved context", lines: ["Saved context:", ...lines, ...(rest > 0 ? ["… " + more(rest, "line")] : [])] };
}

/**
 * The block, or an empty string when no section has data. Over the cap, whole sections are dropped from
 * the end (Saved context first) and one marker line names them: a cut is never silent.
 */
export function renderWorkingMemory(parts: WorkingMemoryParts, _now: Date): string {
  const kept: Section[] = [
    peopleSection(parts.people ?? []),
    goalsSection(parts.goals ?? []),
    inFlightSection(parts.inFlight),
    lastSessionSection(parts.lastSession ?? []),
    standingSection(parts.standing ?? []),
  ].filter((s): s is Section => s !== null);
  if (kept.length === 0) return "";
  const dropped: string[] = [];
  const compose = (): string => {
    const marker = dropped.length > 0 ? ["… not shown (size cap): " + dropped.join(", ")] : [];
    return [WORKING_MEMORY_HEADER, ...kept.flatMap((s) => s.lines), ...marker].join("\n");
  };
  while (compose().length > WORKING_MEMORY_MAX_CHARS && kept.length > 1) dropped.unshift(kept.pop()?.name ?? "");
  return compose().slice(0, WORKING_MEMORY_MAX_CHARS);
}

/**
 * The newest WORKING_MEMORY_MAX_LAST_SESSION turns of the session before the current one. A session ends
 * at a silence of HISTORY_SESSION_GAP_MS (see state.ts), so: when the newest turn is itself that old, the
 * newest turns are the last session; otherwise it is whatever lies behind the latest gap. No gap in the
 * log means no earlier session is known, and the result is empty.
 */
export function selectLastSession(turns: readonly SessionTurn[], now: Date): SessionTurn[] {
  const sorted = [...turns].sort((a, b) => b.at.getTime() - a.at.getTime());
  const newest = sorted[0];
  if (!newest) return [];
  const gapBefore = (i: number): boolean => (sorted[i - 1]?.at.getTime() ?? 0) - (sorted[i]?.at.getTime() ?? 0) >= HISTORY_SESSION_GAP_MS;
  let start = now.getTime() - newest.at.getTime() >= HISTORY_SESSION_GAP_MS ? 0 : -1;
  for (let i = 1; start < 0 && i < sorted.length; i++) if (gapBefore(i)) start = i;
  const first = sorted[start];
  if (start < 0 || !first) return [];
  const session = [first];
  for (let i = start + 1; i < sorted.length && session.length < WORKING_MEMORY_MAX_LAST_SESSION && !gapBefore(i); i++) {
    const t = sorted[i];
    if (t) session.push(t);
  }
  return session;
}

async function withTimeout<T>(run: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out after " + ms + " ms")), ms);
  });
  try {
    return await Promise.race([Promise.resolve().then(run), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** One section read: its value, or undefined after a logged warning. */
async function readSection<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await withTimeout(run, WORKING_MEMORY_SECTION_TIMEOUT_MS);
  } catch (err) {
    log.warn({ section: name, err: String(err) }, "Working-memory section skipped"); // allow-failopen: context for the answer; one failing reader must not cost the founder the answer
    return undefined;
  }
}

/** An empty string without a source, a thread id or an applicable thread, and when disabled. A failing reader omits only its own section. */
export async function workingMemoryBlockFor(
  source: WorkingMemorySource | undefined,
  threadId: unknown,
  now: Date,
  enabled = true,
): Promise<string> {
  if (!enabled || !source || typeof threadId !== "string" || threadId === "" || !source.appliesTo(threadId)) return "";
  const [people, goals, inFlight, turns, standing] = await Promise.all([
    readSection("people", () => source.people(threadId, now)),
    readSection("goals", () => source.goals(threadId, now)),
    readSection("in-flight", () => source.inFlight(threadId, now)),
    readSection("last-session", () => source.recentTurns(threadId, now)),
    readSection("standing", () => source.standing(threadId, now)),
  ]);
  return renderWorkingMemory({ people, goals, inFlight, lastSession: turns ? selectLastSession(turns, now) : undefined, standing }, now);
}

/** What the plan node is given: both halves of the founder-context block. */
export interface FounderContext {
  readonly workingMemory?: WorkingMemorySource | undefined;
  readonly recentActivity?: RecentActivitySource | undefined;
  /** WORKING_MEMORY_ENABLED; default on. */
  readonly workingMemoryEnabled?: boolean | undefined;
}

/** The plan node single call: working memory first, then recent work from other agents (AG-029). */
export async function founderContextBlockFor(ctx: FounderContext | undefined, threadId: unknown, now: Date): Promise<string> {
  if (!ctx) return "";
  const [memory, recent] = await Promise.all([
    workingMemoryBlockFor(ctx.workingMemory, threadId, now, ctx.workingMemoryEnabled ?? true),
    recentActivityBlockFor(ctx.recentActivity, threadId, now),
  ]);
  return [memory, recent].filter(Boolean).join("\n\n");
}
