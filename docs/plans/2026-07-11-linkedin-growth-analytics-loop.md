# Plan: LinkedIn growth analytics loop

**Status:** Planned (Phase 2)  
**Owner:** Marketing / infra  
**Depends on:** `schedule_social_post` on `main`, `linkedin_analytics` agent tool (wired in PR #310 branch)

---

## Problem

Marketing can call `linkedin_analytics` per post today, but metrics are **ephemeral** — nothing is stored, ranked, or surfaced on a cadence. Scheduled growth posts (personal + @Turicks) need a **learn → draft → schedule** loop without founder manually comparing posts.

---

## Target behavior

```
Weekly (or before each scheduled draft):
  runLinkedInAnalyticsSweep()
    → linkedin_get_my_posts + linkedin_analytics per ID
    → upsert linkedin_post_metrics table

Telegram / marketing worker:
  "What should we post next?"
    → query top posts by reactions+comments (last 30d)
    → draft using winning hook + pillar + prepareLinkedInFeedPost("scheduled_feed")
    → schedule_social_post with HITL once
```

---

## Schema (proposed)

```sql
CREATE TABLE linkedin_post_metrics (
  id serial PRIMARY KEY,
  tenant_id text NOT NULL,
  post_id text NOT NULL,
  account_key text NOT NULL,  -- personal | turicks
  impressions int,
  reactions int,
  comments int,
  shares int,
  snapshot_at timestamptz NOT NULL,
  UNIQUE (tenant_id, post_id, snapshot_at)
);
```

Join to `action_log` on `post_id` for text snippet + pillar tag (add optional `pillar` to audit payload).

---

## Implementation checklist

1. Migration `0012_linkedin_post_metrics.sql`
2. `src/infra/linkedin-metrics-sweep.ts` — cron weekly + manual `pnpm linkedin:metrics-sweep`
3. `src/db/queries.ts` — `upsertPostMetrics`, `getTopPostsByEngagement`
4. Marketing prompt workflow — prefer DB summary when `linkedin_analytics` returns 403
5. Unit tests with mocked provider; integration test with fixture JSON
6. Document in `LINKEDIN-ACCOUNT-AND-GROWTH-STRATEGY.md` § analytics

---

## Out of scope (this plan)

- Follower count API (limited LinkedIn access)
- Auto-publish without HITL
- A/B testing two hooks in one week (manual for now)

---

## Success criteria

- Founder asks “what performed best?” → agent returns ranked list with hooks from last 30 days without live API calls.
- Scheduled post drafts reference at least one metric from top posts when data exists.
