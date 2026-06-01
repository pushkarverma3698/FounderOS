# Phase 3 — Social Pod + Engineering Agent

**Goal**: Extend FounderOS with a social media automation department and a senior engineering agent with GitHub access.

**Status**: In Progress
**Started**: 2026-06-01

---

## Deliverables

### Social Department
- [ ] `social_linkedin` agent in registry (cascade: md, tools: composio_linkedin_post, composio_linkedin_reply, content_scheduler)
- [ ] `social_instagram` agent in registry (cascade: nano, tools: composio_instagram_post, media_formatter)
- [ ] System prompts in `src/core/prompts.ts` for both agents
- [ ] Social pod file: `src/agents/pods/social.ts`
- [ ] Batch content generation: `generateWeeklyContent(brief)` → 1 LLM call → 7 posts → Redis 7-day TTL
- [ ] Critic node wired for social posts before HITL
- [ ] Quota check wired for social posts (respect posting limits)

### Senior Engineering Agent
- [ ] `senior_engineer` agent in registry (cascade: ceo, tools: github_create_pr, github_push_files, github_read, code_review, run_tests)
- [ ] System prompt in `src/core/prompts.ts`
- [ ] HITL gate on every `merge_pull_request` call
- [ ] Composio GitHub tool integration verified
- [ ] PR creation writes to `audit_log` before GitHub call (idempotency)

### Token Optimization
- [ ] Prompt caching added to `src/infra/llm.ts` (cache_control for system prompts > 1024 tokens)
- [ ] Ollama local routing wired for JSON extraction and classification tasks
- [ ] Redis LLM output cache TTL confirmed at 6h
- [ ] Content template cache: 7-day TTL in Redis

### Infrastructure
- [ ] DB self-healing cron: monthly orphan detection + audit log remediation
- [ ] GitHub diagram push cron: after each phase completion
- [ ] `docs/study/CASE-STUDY-LOG.md` started + first entry written

---

## Architecture Decisions Made

- Social pod uses Composio tools for all platform auth — no direct OAuth in FounderOS
- All social content goes through critic before HITL (brand voice enforcement)
- senior_engineer cascade tier = ceo (needs architectural reasoning capability)
- HITL required for merge, not for PR creation (PR creation is low-risk write)

---

## Success Criteria

- `social_linkedin`, `social_instagram`, `senior_engineer` all appear in `getAgent()` calls
- `pnpm test` passes with new unit + integration tests green
- Batch content generation test: confirms exactly 1 LLM call for 7-post output
- senior_engineer can create a real PR to founderos repo (verified in live test)
- Token optimization: prompt caching active for ceo/deep_research tier system prompts

---

## Open Questions

- Instagram API: confirm Composio supports Instagram Basic Display API or Graph API — needed for posting
- Content approval flow: does Instagram post also require HITL, or is LinkedIn-only sufficient for now?

---

## Verification Results

_(to be filled when phase completes)_
