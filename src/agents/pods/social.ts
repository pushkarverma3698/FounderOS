/**
 * FounderOS — Social Media Pod
 * =============================
 * Graph: content_researcher → post_writer → critic → [HITL] → publisher
 *
 * Safety-first LinkedIn publishing with:
 *  - Account warming (4-week ramp from 1→uncapped posts/week)
 *  - Circuit breaker (3 consecutive failures → 24h cooldown)
 *  - HITL gate before every publish (founder always approves)
 *  - Composio OAuth publishing (NOT scraping — safe approach)
 *
 * Inspired by patterns from the linkedin-automation-tool project.
 * Key difference: we use FounderOS's DB-backed HITL + LangGraph checkpointing
 * instead of Inngest's step.waitForEvent. Same safety guarantees, cleaner architecture.
 *
 * LinkedIn ban risk matrix:
 *  LOW RISK:  Content creation, scheduling, analytics reads
 *  MED RISK:  Posting (mitigated by warming + HITL)
 *  HIGH RISK: Automated DMs, bulk connection requests — these are NOT in Phase 1
 */

import { StateGraph, END, START } from "@langchain/langgraph";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { SocialState } from "../state.js";
import type { SocialStateType, AccountWarmingConfig } from "../state.js";
import { callCascade } from "../../infra/llm.js";
import { requestHITL } from "../../gateway/hitl.js";
import { hasBeenAudited, writeAuditEntry } from "../../db/queries.js";
import { criticNode, afterCriticEdge } from "../critic.js";
import { prepareForLlm } from "../../infra/token-optimizer.js";
import { childLogger } from "../../infra/logger.js";

const log = childLogger({ module: "social_pod" });

// ── Account Warming Helpers ───────────────────────────────────────────────────

/**
 * Calculate current weekly post limit based on account age.
 * Week 0 (new): 1/week — Week 1: 2/week — Week 2: 4/week — Week 3: 7/week — Week 4+: uncapped
 *
 * Source: LinkedIn automation community consensus (Phantombuster, Expandi guidelines).
 * Conservative by design: better to under-post early than risk account flag.
 */
export function calculateWeeklyLimit(warmingStartedAt: string): number {
  const startDate = new Date(warmingStartedAt);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
  const weeksOld = Math.floor(diffDays / 7);

  if (weeksOld === 0) return 1;
  if (weeksOld === 1) return 2;
  if (weeksOld === 2) return 4;
  if (weeksOld === 3) return 7;
  return 999; // Uncapped after 4 weeks
}

/**
 * Returns true if the account is safe to post based on warming state.
 */
export function isPostingAllowed(warming: AccountWarmingConfig): boolean {
  const limit = calculateWeeklyLimit(warming.warming_started_at);
  return warming.posts_this_week < limit;
}

// ── Content Researcher Node ───────────────────────────────────────────────────

async function contentResearcherNode(
  state: SocialStateType,
): Promise<Partial<SocialStateType>> {
  log.info({ task: state.task.slice(0, 60) }, "Social pod: content_researcher");

  const systemPrompt = `You are a social media content researcher.
Analyze trends, competitor posts, and audience preferences.
Return a concise research brief (max 400 words) with:
1. Top 3 trending angles on this topic
2. Competitor post formats that performed well
3. Recommended hook styles for ${state.target_platform}
4. Optimal post length and structure for this platform

Be specific. No generic advice.`;

  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage(`Research social content for:\n\n${state.task}\nPlatform: ${state.target_platform}`),
  ];

  const result = await callCascade("deep_research", messages, {
    agent: "social_researcher",
    tenant_id: state.tenant_id,
  });

  const trend_report = prepareForLlm(result.text, {
    maxTokens: 500,
    strategy: "sentences",
  });

  return { trend_report };
}

// ── Post Writer Node ──────────────────────────────────────────────────────────

async function postWriterNode(
  state: SocialStateType,
): Promise<Partial<SocialStateType>> {
  log.info({}, "Social pod: post_writer");

  const latestCritique = state.critiques.at(-1);
  const revisionContext = latestCritique
    ? `\n\nPREVIOUS CRITIQUE (revision ${state.revision_count}):\n${latestCritique.notes}\nViolations: ${latestCritique.rule_violations.join(", ")}\n\nFix these issues.`
    : "";

  const platformRules: Record<string, string> = {
    linkedin: "Professional tone. Start with a hook (not 'I'). Max 3 paragraphs. 1 clear CTA. No hashtag spam (max 3). Line breaks between paragraphs.",
    twitter: "Under 280 chars OR thread. Hook in first tweet. No filler words.",
    instagram: "Visual-first copy. Emoji OK. Hashtags at end. Story-driven.",
    multi: "Write LinkedIn version first. Keep it professional and concise.",
  };

  const rules = platformRules[state.target_platform] ?? platformRules.linkedin;

  const systemPrompt = `You are a social media copywriter for Turicks AI Agency.
Platform: ${state.target_platform}
Rules: ${rules}

BANNED: "excited to share", "game-changer", "synergy", "I'm thrilled", "hope this finds you well"
Return ONLY the post text. No intro, no explanation.`;

  const userContent = `Research brief:\n${state.trend_report ?? "No research available"}\n\nOriginal task: ${state.task}${revisionContext}`;

  const messages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    new HumanMessage(userContent),
  ];

  const result = await callCascade("md", messages, {
    agent: "social_handler",
    tenant_id: state.tenant_id,
  });

  log.info({ preview: result.text.slice(0, 80) }, "Post draft generated");

  return {
    post_draft: result.text.trim(),
    revision_count: state.revision_count + 1,
  };
}

// ── Critic Wrapper ────────────────────────────────────────────────────────────

async function criticSocialNode(
  state: SocialStateType,
): Promise<Partial<SocialStateType>> {
  return criticNode(state, "marketing"); // Social uses marketing critique rules
}

// ── HITL Node ─────────────────────────────────────────────────────────────────

async function hitlNode(
  state: SocialStateType,
): Promise<Partial<SocialStateType>> {
  const latestCritique = state.critiques.at(-1);
  const isEscalated =
    latestCritique?.result === "NEEDS_REVISION" &&
    state.revision_count >= state.max_revisions;

  const summary = isEscalated
    ? `⚠️ Escalated after ${state.revision_count} revisions. Issue: ${latestCritique?.notes}`
    : `Social post ready for approval.\nPlatform: ${state.target_platform}`;

  const hitl = await requestHITL({
    thread_id: `${state.tenant_id}:social:${state.trace_id}`,
    tenant_id: state.tenant_id,
    agent: "social_handler",
    summary,
    draft: state.post_draft ?? "(no draft)",
    ttl_minutes: 120,
  });

  log.info({ interrupt_id: hitl.interrupt_id, escalated: isEscalated }, "Social HITL requested");

  return { hitl };
}

// ── Publisher Node ────────────────────────────────────────────────────────────

async function publisherNode(
  state: SocialStateType,
): Promise<Partial<SocialStateType>> {
  const idempotencyKey = `social_publish:${state.trace_id}`;

  if (await hasBeenAudited(idempotencyKey)) {
    log.info({ idempotency_key: idempotencyKey }, "Already published — skipping");
    return {};
  }

  // ── Account warming check ──────────────────────────────────────────────────
  if (state.warming) {
    if (!isPostingAllowed(state.warming)) {
      const limit = calculateWeeklyLimit(state.warming.warming_started_at);
      log.warn(
        {
          posts_this_week: state.warming.posts_this_week,
          limit,
          warming_started: state.warming.warming_started_at,
        },
        "Account warming limit reached — deferring publish",
      );

      return {
        final: {
          status: "deferred",
          reason: `Weekly posting limit (${limit}) reached. Account is warming up.`,
          posts_this_week: state.warming.posts_this_week,
          retry_after: "next Monday UTC",
        },
      };
    }
  }

  // ── Circuit breaker check ──────────────────────────────────────────────────
  if (state.circuit_open) {
    log.warn({}, "Circuit breaker open — LinkedIn publishing suspended");
    return {
      final: {
        status: "circuit_open",
        reason: "LinkedIn publishing circuit open after consecutive failures. Retrying in 24h.",
      },
    };
  }

  // ── Phase 1B stub — real Composio integration is Phase 1C ─────────────────
  // TODO Phase 1C: replace with Composio LinkedIn publish
  // const composioClient = new OpenAIToolSet({ apiKey: env.COMPOSIO_API_KEY });
  // await composioClient.executeAction("LINKEDIN_CREATE_LINKEDIN_POST", { text: state.post_draft });
  log.info(
    { platform: state.target_platform, preview: state.post_draft?.slice(0, 80) },
    "Social pod: publisher (Phase 1B stub — Composio integration in Phase 1C)",
  );

  const published_post = {
    platform: state.target_platform === "multi" ? "linkedin" : state.target_platform,
    content: state.post_draft ?? "",
    published_at: new Date().toISOString(),
    post_id: `stub-${Date.now()}`,
  } as const;

  await writeAuditEntry({
    tenant_id: state.tenant_id,
    action: "social_publish",
    idempotency_key: idempotencyKey,
    payload: {
      platform: published_post.platform,
      post_preview: state.post_draft?.slice(0, 120),
      hitl_interrupt_id: state.hitl?.interrupt_id,
      revision_count: state.revision_count,
    },
  });

  const final = {
    published_post,
    finalized_at: new Date().toISOString(),
    phase: "1B_stub",
  };

  log.info({ platform: published_post.platform }, "Social post finalized");

  return { published_post, final };
}

// ── Graph definition ──────────────────────────────────────────────────────────

const socialGraph = new StateGraph(SocialState)
  .addNode("content_researcher", contentResearcherNode)
  .addNode("post_writer", postWriterNode)
  .addNode("critic", criticSocialNode)
  .addNode("hitl_gate", hitlNode)
  .addNode("publisher", publisherNode)

  .addEdge(START, "content_researcher")
  .addEdge("content_researcher", "post_writer")
  .addEdge("post_writer", "critic")
  .addConditionalEdges("critic", afterCriticEdge, {
    generator: "post_writer",
    hitl: "hitl_gate",
  })
  .addEdge("hitl_gate", "publisher")
  .addEdge("publisher", END);

export const socialSubgraph = socialGraph.compile();
