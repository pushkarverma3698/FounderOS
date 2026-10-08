/**
 * FounderOS gateway — the reader behind the planner working-memory block (AG-032)
 * ===============================================================================
 * Composes the five sections of the kernel working-memory module from stored data, with SQL, in-process
 * config and one cached GitHub read. No LLM and no embedding call. Wired in kernel-boot.ts.
 *
 *   People         the registered job profiles (founder flag = the default profile; no relation is guessed)
 *   Goals          open goals, numbered as the goal command numbers them
 *   In flight      open PRs and agent tasks per dispatch repo, from a stale-while-revalidate cache
 *   Last session   the asking thread conversation_turns, before the latest 6 h silence
 *   Saved context  founder_context keys the founder saved himself (update_context), dated by the context renderer
 *
 * Scope: the founder DM thread and the family group (TELEGRAM_ANSWER_ALL_CHAT_IDS) only.
 * Turns are always read by the asking thread id, so the group never reads the private chat history.
 */
import { env, TENANT } from "../core/config.js";
import { getFounderContext } from "../db/queries.js";
import { LAST_UPDATED_KEY, founderFacingContext } from "../db/founder-context.js";
import { readContextMeta } from "../db/context-meta.js";
import { findConversationTurns, type RecalledTurn } from "../db/conversation-turns.js";
import { createPgGoalRepo } from "../goals/pg-repo.js";
import type { GoalRow } from "../goals/types.js";
import { chatIdFromThreadId } from "../infra/telegram-send.js";
import { childLogger } from "../infra/logger.js";
import type { GoalEntry, InFlightEntry, InFlightSnapshot, PersonEntry, SessionTurn, WorkingMemorySource } from "../kernel/working-memory.js";
import { DEFAULT_PROFILE_ID, listProfiles } from "../tools/jobhunt/profile-config.js";
import { DISPATCH_REPO_ALLOWLIST } from "../tools/dispatch-repos.js";
import { fetchRepoStatus, type RepoStatusView } from "../tools/repo-status.js";
import { contextLineRenderer } from "../tools/context-render.js";
import { buildChatAccessConfig } from "./chat-access.js";

const log = childLogger({ module: "gateway:working-memory" });

/** How far back the turn log is read to find the last session. */
const TURN_LOOKBACK_DAYS = 30;
const TURN_READ_LIMIT = 60;
/** A GitHub snapshot younger than this is served as is; an older one is served once more while a refresh runs. */
export const IN_FLIGHT_TTL_MS = 5 * 60_000;

export interface WorkingMemoryDeps {
  readonly founderChatId: string;
  readonly familyChatIds: ReadonlySet<string>;
  readonly tenant: string;
  readonly profiles: () => readonly { readonly id: string; readonly candidateName: string }[];
  readonly founderProfileId: string;
  readonly openGoals: (tenant: string) => Promise<readonly GoalRow[]>;
  readonly repos: readonly string[];
  readonly repoStatus: (repos: readonly string[]) => Promise<RepoStatusView>;
  readonly turns: (threadId: string, since: Date) => Promise<readonly RecalledTurn[]>;
  readonly context: (tenant: string) => Promise<Record<string, unknown>>;
}

export function defaultWorkingMemoryDeps(): WorkingMemoryDeps {
  const access = buildChatAccessConfig({ primaryChatId: env.TELEGRAM_CHAT_ID, answerAllChatIds: env.TELEGRAM_ANSWER_ALL_CHAT_IDS });
  return {
    founderChatId: access.primaryChatId,
    familyChatIds: access.answerAllChatIds,
    tenant: TENANT,
    profiles: listProfiles,
    founderProfileId: DEFAULT_PROFILE_ID,
    openGoals: (tenant) => createPgGoalRepo().listOpenGoals(tenant),
    repos: DISPATCH_REPO_ALLOWLIST,
    repoStatus: (repos) => fetchRepoStatus(repos),
    turns: async (threadId, since) => (await findConversationTurns({ threadId, since, terms: [], limit: TURN_READ_LIMIT })).turns,
    context: getFounderContext,
  };
}

function inFlightFrom(view: RepoStatusView): InFlightEntry[] {
  const items: InFlightEntry[] = [];
  for (const s of view.summaries) {
    const failing = new Set(s.blocked.failingPrs.map((p) => p.number));
    for (const p of s.inFlight.openPrs) {
      const notes = [...(p.draft ? ["draft"] : []), ...(failing.has(p.number) ? ["checks failing"] : [])];
      items.push(notes.length > 0 ? { repo: s.slug, kind: "PR", number: p.number, title: p.title, note: notes.join(", ") } : { repo: s.slug, kind: "PR", number: p.number, title: p.title });
    }
    for (const t of s.inFlight.agentIssues) items.push({ repo: s.slug, kind: "task", number: t.number, title: t.title });
  }
  return items;
}

export function buildWorkingMemorySource(deps: WorkingMemoryDeps = defaultWorkingMemoryDeps()): WorkingMemorySource {
  let cache: InFlightSnapshot | undefined;
  let refreshing: Promise<InFlightSnapshot> | undefined;

  const refresh = (now: Date): Promise<InFlightSnapshot> => {
    refreshing ??= deps
      .repoStatus(deps.repos)
      .then((view) => {
        // Nothing reached at all is a failure, not an empty board: it must not be cached as the truth.
        if (view.summaries.length === 0 && view.unreachable.length > 0) throw new Error(view.unreachable[0]?.error ?? "GitHub unreachable");
        cache = { items: inFlightFrom(view), asOf: now };
        return cache;
      })
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  };

  return {
    appliesTo: (threadId) => {
      const chat = chatIdFromThreadId(threadId);
      return chat !== undefined && (chat === deps.founderChatId || deps.familyChatIds.has(chat));
    },

    people: async () =>
      deps.profiles().map((p): PersonEntry => ({ name: p.candidateName, profile: p.id, founder: p.id === deps.founderProfileId })),

    goals: async () =>
      (await deps.openGoals(deps.tenant)).map((g, i): GoalEntry => ({ n: i + 1, title: g.title, dueOn: g.due_on, target: g.target })),

    inFlight: async (_threadId, now) => {
      if (cache && now.getTime() - cache.asOf.getTime() < IN_FLIGHT_TTL_MS) return cache;
      const pending = refresh(now);
      if (!cache) return pending;
      pending.catch((err: unknown) => log.warn({ err: String(err) }, "In-flight refresh failed — serving the older snapshot")); // allow-failopen: the stale snapshot carries its own as-of time
      return cache;
    },

    recentTurns: async (threadId, now) => {
      const since = new Date(now.getTime() - TURN_LOOKBACK_DAYS * 86_400_000);
      return (await deps.turns(threadId, since)).map((t): SessionTurn => ({ at: t.occurred_at, asked: t.user_input, outcome: t.outcome }));
    },

    standing: async (_threadId, now) => {
      const ctx = await deps.context(deps.tenant);
      const { entries } = readContextMeta(ctx);
      const line = contextLineRenderer(ctx, now);
      return Object.entries(founderFacingContext(ctx))
        .filter(([key, value]) => key !== LAST_UPDATED_KEY && Object.hasOwn(entries, key) && entries[key]?.source === "founder" && !(Array.isArray(value) && value.length === 0))
        .map(([key, value]) => line(key, value));
    },
  };
}
