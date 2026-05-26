/**
 * FounderOS — All State Types
 * ============================
 * Single file for ALL LangGraph state schemas and shared interfaces.
 * Agents import from here — never define state elsewhere.
 *
 * Design decisions:
 * - Annotation.Root() for type-safe LangGraph state
 * - append-only reducers for arrays (critiques, errors) — full history preserved
 * - schema_version on every state for safe future migrations
 * - HITLRecord references interrupt_registry.interrupt_id (FK enforced in code)
 *
 * LangGraph 0.2.x note:
 * Non-reducer fields MUST include `value: (_x, y) => y` — this is the identity
 * reducer (last-write-wins). Fields that manage their own merge logic use a
 * custom `reducer` function instead. See ADR-001.
 */

import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";

// ── Shared Interfaces ─────────────────────────────────────────────────────────

/** ICP-enriched lead profile built by lead_intel agent. */
export interface LeadProfile {
  name: string;
  company: string;
  url: string;
  pain_points: string[];
  /** Normalized 0.0–1.0 fit against Turicks ICP */
  icp_score: number;
  budget_signal: "high" | "medium" | "low" | "unknown";
  linkedin_url?: string;
  source: "upwork" | "linkedin" | "referral" | "inbound" | "cold_email";
}

/** Single critic evaluation. Append-only — stores full revision history. */
export interface CritiqueRecord {
  result: "APPROVED" | "NEEDS_REVISION";
  notes: string;
  /** Model that produced the critique — MUST differ from generator model. */
  critic_model: string;
  timestamp: string;
  rule_violations: string[];
}

/**
 * HITL interrupt state — DB-backed before interrupt() is called.
 * interrupt_id is the FK to interrupt_registry table.
 */
export interface HITLRecord {
  status: "pending" | "approved" | "rejected" | "expired";
  interrupt_id: string;
  telegram_message_id?: number;
  requested_at: string;
  resolved_at?: string;
  rejection_reason?: string;
  /** Optional human edits to the draft before approval */
  edits?: string;
}

// ── Root State (top-level FounderGraph) ───────────────────────────────────────

export const FounderState = Annotation.Root({
  /** Bump when the shape changes — enables safe migration. */
  schema_version: Annotation<number>({
    value: (_x, y) => y,
    default: () => 1,
  }),

  /** UUID for LangSmith / pino correlation. */
  trace_id: Annotation<string>({
    value: (_x, y) => y,
    default: () => crypto.randomUUID(),
  }),

  /** Which company context this run belongs to. */
  tenant_id: Annotation<string>({
    value: (_x, y) => y,
    default: () => "turicks",
  }),

  /** LangGraph message history — standard append reducer. */
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  /** Raw task string from Telegram (user turn). */
  task: Annotation<string>({
    value: (_x, y) => y,
    default: () => "",
  }),

  /** CEO classification output → routes to pod. */
  department: Annotation<"sales" | "engineering" | "marketing" | "social" | "">({
    value: (_x, y) => y,
    default: () => "",
  }),

  /** Final output written by the pod before HITL / send. */
  result: Annotation<string>({
    value: (_x, y) => y,
    default: () => "",
  }),

  /** Skip HITL and send directly — set true only for low-stakes nano tasks. */
  auto_approve: Annotation<boolean>({
    value: (_x, y) => y,
    default: () => false,
  }),

  /** Accumulated errors — append-only so we never lose context. */
  errors: Annotation<Record<string, unknown>[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
});

export type FounderStateType = typeof FounderState.State;

// ── Sales Pod State ───────────────────────────────────────────────────────────

export const SalesState = Annotation.Root({
  schema_version: Annotation<number>({
    value: (_x, y) => y,
    default: () => 1,
  }),
  trace_id: Annotation<string>({
    value: (_x, y) => y,
    default: () => "",
  }),
  tenant_id: Annotation<string>({
    value: (_x, y) => y,
    default: () => "turicks",
  }),

  /** Task forwarded from FounderState by CEO. */
  task: Annotation<string>({
    value: (_x, y) => y,
    default: () => "",
  }),

  /** Company context (populated from registry). */
  company: Annotation<string>({
    value: (_x, y) => y,
    default: () => "",
  }),

  /** Lead profile built by lead_intel. Null until intel phase completes. */
  lead: Annotation<LeadProfile | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  /** Full intelligence report from lead_intel agent. */
  intel_report: Annotation<string | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  /** Email/DM draft produced by bdr agent. */
  email_draft: Annotation<{ subject: string; body: string } | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  /** Full critique history — append-only for retry transparency. */
  critiques: Annotation<CritiqueRecord[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),

  /** How many revision cycles are allowed before escalating. */
  max_revisions: Annotation<number>({
    value: (_x, y) => y,
    default: () => 2,
  }),

  /** Mutable counter — incremented in the generator node. */
  revision_count: Annotation<number>({
    value: (_x, y) => y,
    default: () => 0,
  }),

  /** Current HITL gate state. */
  hitl: Annotation<HITLRecord | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  /** Post-approval output ready for external send. */
  final: Annotation<Record<string, unknown> | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  errors: Annotation<Record<string, unknown>[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
});

export type SalesStateType = typeof SalesState.State;

// ── Engineering Pod State ─────────────────────────────────────────────────────

export const EngineeringState = Annotation.Root({
  schema_version: Annotation<number>({
    value: (_x, y) => y,
    default: () => 1,
  }),
  trace_id: Annotation<string>({
    value: (_x, y) => y,
    default: () => "",
  }),
  tenant_id: Annotation<string>({
    value: (_x, y) => y,
    default: () => "turicks",
  }),
  task: Annotation<string>({
    value: (_x, y) => y,
    default: () => "",
  }),
  company: Annotation<string>({
    value: (_x, y) => y,
    default: () => "",
  }),

  /** Problem spec from task + any context gathered. */
  spec: Annotation<string | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  /** Generated code/solution by senior_dev or vibe_coder. */
  code_draft: Annotation<string | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  /** QA test results. */
  test_results: Annotation<{ passed: boolean; details: string } | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  critiques: Annotation<CritiqueRecord[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),

  max_revisions: Annotation<number>({
    value: (_x, y) => y,
    default: () => 2,
  }),
  revision_count: Annotation<number>({
    value: (_x, y) => y,
    default: () => 0,
  }),
  hitl: Annotation<HITLRecord | null>({
    value: (_x, y) => y,
    default: () => null,
  }),
  final: Annotation<Record<string, unknown> | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  errors: Annotation<Record<string, unknown>[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
});

export type EngineeringStateType = typeof EngineeringState.State;

// ── Marketing Pod State ───────────────────────────────────────────────────────

export const MarketingState = Annotation.Root({
  schema_version: Annotation<number>({
    value: (_x, y) => y,
    default: () => 1,
  }),
  trace_id: Annotation<string>({
    value: (_x, y) => y,
    default: () => "",
  }),
  tenant_id: Annotation<string>({
    value: (_x, y) => y,
    default: () => "turicks",
  }),
  task: Annotation<string>({
    value: (_x, y) => y,
    default: () => "",
  }),
  company: Annotation<string>({
    value: (_x, y) => y,
    default: () => "",
  }),

  /** Raw trend intelligence from social_researcher. */
  trend_report: Annotation<string | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  /** Content draft (post / campaign). */
  content_draft: Annotation<string | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  critiques: Annotation<CritiqueRecord[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),

  max_revisions: Annotation<number>({
    value: (_x, y) => y,
    default: () => 2,
  }),
  revision_count: Annotation<number>({
    value: (_x, y) => y,
    default: () => 0,
  }),
  hitl: Annotation<HITLRecord | null>({
    value: (_x, y) => y,
    default: () => null,
  }),
  final: Annotation<Record<string, unknown> | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  errors: Annotation<Record<string, unknown>[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
});

export type MarketingStateType = typeof MarketingState.State;

// ── Social Media Pod State ────────────────────────────────────────────────────

/**
 * Account warming schedule — enforced by the publisher node.
 * Inspired by LinkedIn automation best practices (Phantombuster, Expandi guidelines).
 */
export interface AccountWarmingConfig {
  /** ISO date the account started warming (first post date). */
  warming_started_at: string;
  /** Posts published this week (resets each Monday UTC). */
  posts_this_week: number;
  /** Current weekly post limit (calculated from warming_started_at age). */
  weekly_limit: number;
}

/** A published social media post with engagement metadata. */
export interface SocialPost {
  platform: "linkedin" | "twitter" | "instagram";
  content: string;
  published_at?: string;
  post_id?: string;
  /** From composio linkedin analytics */
  engagement?: { likes: number; comments: number; shares: number };
}

export const SocialState = Annotation.Root({
  schema_version: Annotation<number>({
    value: (_x, y) => y,
    default: () => 1,
  }),
  trace_id: Annotation<string>({
    value: (_x, y) => y,
    default: () => "",
  }),
  tenant_id: Annotation<string>({
    value: (_x, y) => y,
    default: () => "cross",
  }),
  task: Annotation<string>({
    value: (_x, y) => y,
    default: () => "",
  }),
  company: Annotation<string>({
    value: (_x, y) => y,
    default: () => "cross",
  }),

  /** Target platform(s) for this post. */
  target_platform: Annotation<"linkedin" | "twitter" | "instagram" | "multi">({
    value: (_x, y) => y,
    default: () => "linkedin",
  }),

  /** Trend and competitor research from social_researcher. */
  trend_report: Annotation<string | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  /** Drafted post content from social_handler. */
  post_draft: Annotation<string | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  /**
   * Account warming state — fetched from DB or initialized fresh.
   * The publisher node reads this to decide if posting is safe.
   */
  warming: Annotation<AccountWarmingConfig | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  /**
   * Circuit breaker state — publisher tracks consecutive failures.
   * If tripped, publishing is suspended for 24h.
   */
  circuit_open: Annotation<boolean>({
    value: (_x, y) => y,
    default: () => false,
  }),

  critiques: Annotation<CritiqueRecord[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),

  max_revisions: Annotation<number>({
    value: (_x, y) => y,
    default: () => 2,
  }),
  revision_count: Annotation<number>({
    value: (_x, y) => y,
    default: () => 0,
  }),
  hitl: Annotation<HITLRecord | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  /** Published post metadata — written by publisher node after successful publish. */
  published_post: Annotation<SocialPost | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  final: Annotation<Record<string, unknown> | null>({
    value: (_x, y) => y,
    default: () => null,
  }),

  errors: Annotation<Record<string, unknown>[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
});

export type SocialStateType = typeof SocialState.State;
