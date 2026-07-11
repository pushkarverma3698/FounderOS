# LinkedIn Engagement Automation — Implementation Plan

**Date:** 2026-07-11
**Status:** DRAFT — plan for review (supersedes the deferred posting/engagement parts of ADR-009)
**Author:** engineering (architecture brainstorm)
**Depends on:** ADR-009 (ban risk), ADR-029 (direct integrations), ADR-036 (account registry)

---

## 0. The decisive finding (read this first)

The market research + LinkedIn platform research collapse to one hard constraint that
dictates the entire architecture:

| Surface | Post | Read engagement | Write comments/replies | Event webhook |
|---|---|---|---|---|
| **Personal profile** (`urn:li:person`) | ✅ live today (`w_member_social`-class) | ❌ `r_member_social` **CLOSED** | ❌ Member Post Mgmt **CLOSED** | ❌ none |
| **Company Page** (`urn:li:organization`) | ✅ `w_organization_social` | ✅ `r_organization_social` | ✅ Comments API | ✅ Organization Social Actions Notifications |

**Source:** LinkedIn Community Management API docs, FAQ #6 (2026-06): *"r_member_social is a
closed permission. We're not accepting access requests at this time due to resource constraints."*

### Consequences

1. **Engagement automation is only buildable on a Turicks Company Page.** The personal
   profile stays **post-only + draft-only-for-replies**, permanently, until LinkedIn reopens
   `r_member_social`. Our current `linkedin_read_comments` 403s for exactly this reason and
   **cannot be fixed** for the personal profile.
2. **Connection requests / DMs have no official API on any surface** — automating them means
   browser-session injection (Phantombuster/HeyReach-class), ~97% detection, ~23% ban rate in
   2026. **This plan does NOT automate them.** ADR-009 Option D (draft → founder sends by hand)
   stands.
3. The unlock for everything else is a **Marketing Developer Platform / Community Management API
   application + app verification** (Development Tier → Standard Tier, the latter needs a
   screencast demo). This is a form-and-review process, not an enterprise contract.

### The strategic reframe

The 2026 algorithm rewards *knowledge exchange*, not volume — it can tell a substantive comment
from "Great post!" So we build a **Presence Engine, not an Outreach Engine**:

- ❌ automate cold invites (banned, low-yield)
- ✅ automate *presence*: consistent Page posting cadence + fast, substantive replies to
  engagement on our content + assisted commenting on others' posts (the #1 organic growth driver)

This is where FounderOS has an unfair advantage: HITL + brand-validator + Claude judge means our
automated presence still sounds like us — exactly what the algorithm now filters for.

---

## 1. Market research → product motion

Every tactic the research validated maps to a concrete build track:

| Market standard (2026) | FounderOS build |
|---|---|
| Comment substantively on others' posts → #1 driver of profile views | **Track C — Comment-Assist** (watchlist → drafted comment → 1-tap approve) |
| Consistency > frequency (3–4 high-value posts/week) | **Track D — Cadence Missions** (kernel-planned, pillar-rotating) |
| Reply fast + substantively to comments on your posts | **Track A+B — Reply Engine** (webhook → drafted reply → approve → post) |
| Inbound-led outbound: content → engagers → warm DM | **Track E — Warm-lead capture** (engagers → CRM signal → `draft_connection_note` for manual send) |
| Trust compounds over 3–6 months; leads are warmer | Proof metrics via existing `action_log` + PROOF.md scoreboard |

---

## 2. Architecture — fitted to the v3 kernel

Nothing here is a side-channel bot. Every write flows through the **one orchestration path**
(plan → dispatch → worker → collect → synthesize) and every external action passes the existing
HITL + quality gates. New components slot into existing seams:

```
                          ┌─────────────────── NEW: LinkedIn webhook ───────────────────┐
                          │  src/gateway/linkedin-webhook.ts (public HTTPS + sig verify) │
                          │  Organization Social Actions Notification → linkedin_events   │
                          │  row (BEFORE any processing; idempotent on comment URN)       │
                          └───────────────────────────┬──────────────────────────────────┘
                                                      │ enqueue kernel mission
   scheduler tick (cadence) ──────────────────────────┤  (planner message, normal path)
                                                      ▼
   message → plan → dispatch → marketing worker ⇄ NEW engagement tools
                                                      │
                    ┌─────────────────────────────────┼──────────────────────────────┐
                    ▼                                 ▼                              ▼
        linkedin_reply_comment*          linkedin_comment_on_post*        linkedin_page_post*
        (reply to engager on OUR post)   (comment on a WATCHLIST post)    (Page cadence post)
                    │                                 │                              │
                    └──── outboundQualityGate (brand-validator + Claude judge) ──────┘
                                                      │
                                              hitlGate (row → interrupt → approve)
                                                      │
                              provider: directLinkedInOrg* (Comments/Posts API, org URN)
                                                      │
                                     ToolReceipt + action_log audit row (real success only)
```

### 2.1 Provider layer (`src/infra/providers/linkedin-direct.ts`)

Add organization-scoped methods (all `urn:li:organization:*` author, Community Management API):

- `directLinkedInOrgPost(input)` — POST `/rest/posts` with an org author. Reuses existing post
  body builder; only the `author` URN + scope differ. **Corrects a latent bug:** default
  `LINKEDIN_API_VERSION=202506` is now **sunset** — bump default to the current versioned header.
- `directLinkedInCreateComment(objectUrn, text)` — POST
  `/rest/socialActions/{urn}/comments` (the sanctioned reply write; `{urn}` = our post or a
  parent comment for threaded replies).
- `directLinkedInReadOrgComments(shareUrn, opts)` — GET comments on a Page post
  (`r_organization_social`, not the closed member scope) → replaces the 403-prone member reader
  for the Page surface.
- `directLinkedInFollowerStats()` / `directLinkedInPageStats()` — real follower/impression
  numbers for the PROOF scoreboard (no more fabrication risk).

Rate budget is generous: Dev Tier = 500 req/app/day, 100 req/member/day; 429 → existing
retriable classification in `src/agents/model.ts`.

### 2.2 Account registry (`src/core/accounts.ts`)

Add a Page identity so tools resolve the org URN deterministically (never hardcoded):

```ts
// new account_key OR new platform-scoped URN on turicks:
turicks → linkedin_org → direct   (LINKEDIN_ORG_URN + LINKEDIN_ORG_ACCESS_TOKEN)
```

Keep `turicks → linkedin (person)` as-is for the personal profile post path. Marketing dept
default for the *engagement* tools resolves to the org identity.

### 2.3 Tools (`src/tools/` + `src/agents/agent-tools/comms.ts`)

New UnifiedTools + LangChain wrappers, all reusing `outboundQualityGate` + `hitlGate` + `idemKey`:

| Tool | Gate | Notes |
|---|---|---|
| `linkedin_page_post` | HITL | Page cadence post; brand+judge gated like `linkedin_post` |
| `linkedin_reply_comment` | HITL (auto-mode configurable) | Replies to a comment on OUR post via Comments API |
| `linkedin_comment_on_post` | HITL | Substantive comment on a watchlist post (the growth driver) |
| `linkedin_read_engagement` | none (read-only) | Page comments/reactions via `r_organization_social` |
| `draft_connection_note` | HITL (existing) | Unchanged — warm-lead manual send, ADR-009 |

Register in `DEPARTMENT_TOOLS.marketing` and add gated names to `HITL_GATED_TOOLS`
(`src/agents/capabilities.ts`). The capability manifest auto-regenerates — no prose drift.

### 2.4 Webhook ingestion (`src/gateway/linkedin-webhook.ts` — NEW surface)

FounderOS today has two inbound surfaces (Telegram, MCP server); this adds a third. Requirements:

- Public HTTPS endpoint + LinkedIn's URL-validation handshake + **signature verification**
  (treat every payload as untrusted external data — same discipline as GitHub webhook events).
- On receipt: write a `linkedin_events` row **before** processing (crash-recoverable, idempotent
  on comment URN — mirrors the HITL "DB row before side-effect" rule).
- Then enqueue a **kernel mission** ("A comment arrived on our post: '…' by {author}. Draft a
  reply.") onto the normal plan→worker path. The webhook does **zero** LLM work itself.

### 2.5 Cadence missions (`src/infra/scheduler.ts`)

`scheduler.ts` already documents the intent: *"the v2 feature crons … return as kernel-planned
scheduled missions when re-justified."* This is that re-justification. Add zero-LLM ticks that
**enqueue planner messages** (they don't post directly):

- `enqueuePillarPost` — rotates BUILD_LOG / FOUNDER_STORY / AI_EDUCATION / REVENUE / SHOWCASE,
  3–4×/week, into the marketing worker (which self-researches + drafts + HITL-gates).
- `enqueueCommentSweep` — periodic "check watchlist posts worth engaging" mission.

Both fire as **normal kernel runs** → HITL card lands in Telegram → founder taps approve.

### 2.6 Contracts (`src/kernel/contracts.ts`)

Add a typed `EngagementResult` StepResult variant + `OUTPUT_CONTRACTS` entry so an "I replied"
claim is Zod-validated against a real Comments API receipt (post URN present) — extending the
existing zero-hallucination mechanism to the new actions.

---

## 3. The autonomy ladder (the real design decision)

"As much automation as we can" is a dial, not a boolean. Expose it as a per-action-type policy
(env/config, deterministic — never a prompt instruction):

| Action | Recommended default | Rationale |
|---|---|---|
| Page cadence post | **HITL-auto** (draft → approve card → posts on tap) | Voice/brand risk is highest on originated content |
| Reply to comment on our post | **HITL-auto**, with a **sentiment-escalation rule**: neutral/positive → 1-tap card; negative/sensitive → full manual draft | ~2s/reply, preserves judgment where it matters |
| Comment on watchlist post | **HITL-auto** | Public expertise = brand surface; keep the gate |
| Reactions (like) on engager comments | **Full-auto** (bounded rate, no card) | Low-risk acknowledgment; frees the founder's taps for replies |
| Connection request / DM | **Draft-only, manual send** | No official API — automation = ban. Non-negotiable. |

**Graduation path:** replies start HITL-auto; after N weeks of >90% approval-without-edit, offer a
`FULL_AUTO_REPLIES` flag that drops the card for positive-sentiment replies only, still routing
anything negative/nuanced to the founder. Never auto-post a reply to a critical/sensitive comment.

---

## 4. Phased delivery (each phase ships behind a flag, gated by `pnpm gate` + live-path proof)

**Phase 0 — Access (external, do first, ~1–3 wks lead time).**
Apply for Community Management API (Dev Tier), create/verify the Turicks Company Page + app,
complete Standard Tier screencast. *Blocking dependency for Phases 2–4.* Nothing to code.

**Phase 1 — Page posting (no new access gates beyond org scope).**
`directLinkedInOrgPost` + `linkedin_page_post` tool + org account registry entry + version-header
fix. Proof: post to the Page via the live path, see the `action_log` row. Reuses all existing
gates → lowest-risk first ship.

**Phase 2 — Reply Engine (needs webhook infra).**
`linkedin-webhook.ts` + `linkedin_events` table + `directLinkedInReadOrgComments` +
`directLinkedInCreateComment` + `linkedin_reply_comment` tool + sentiment-escalation gate.
Proof: real comment on our Page post → card in Telegram → approve → reply appears on LinkedIn →
audit row.

**Phase 3 — Comment-Assist (the growth engine).**
Watchlist config + `linkedin_comment_on_post` + `enqueueCommentSweep` cadence tick. Proof:
sweep surfaces a watchlist post → drafted comment card → approve → comment posts.

**Phase 4 — Cadence + Proof loop.**
`enqueuePillarPost` scheduler ticks + `directLinkedInFollowerStats`/`PageStats` feeding
`docs/PROOF.md`. Closes the loop: automated presence + real (non-fabricated) growth metrics.

**Phase 5 (optional) — Reaction auto-ack + FULL_AUTO_REPLIES graduation.**

---

## 5. Guardrails preserved (nothing here weakens the v3 invariants)

- **Zero-hallucination:** every "posted/replied/commented" claim gated on a real Comments/Posts
  API receipt (`validateStepResult` + new `EngagementResult` contract). Follower/impression
  numbers come from the Stats API, never the model.
- **HITL:** `linkedin_events` + `hitl_approvals` rows written BEFORE `interrupt()`; idempotency
  (`idemKey`, time-invariant) before every external send; audit row only on real success.
- **Determinism:** sentiment-escalation, rate caps, pillar rotation, autonomy-mode selection are
  **pure unit-tested functions**, not prompt instructions.
- **Ban-safety:** we only ever call official, sanctioned org-scope endpoints. No browser
  injection, no connection/DM automation, no member-scope scraping. Per-day rate caps well under
  the 500/100 Dev-Tier budget.
- **Untrusted input:** webhook payloads + comment text treated as external data (like GitHub
  webhook events) — never allowed to redirect the agent's task.
- **LOC budget:** webhook, org-provider methods, and each tool split into <400-line modules.

---

## 6. Concrete change surface (for the eventual PRs)

**New files**
- `src/gateway/linkedin-webhook.ts` — inbound notification handler
- `src/tools/linkedin-page.ts` — Page post + engagement UnifiedTools
- `src/infra/providers/linkedin-org.ts` — org-scoped provider methods (keep linkedin-direct.ts <400 LOC)
- `src/kernel/engagement-policy.ts` — pure sentiment/rate/autonomy-mode functions
- `docs/decisions/044-linkedin-engagement-automation.md` — the ADR this plan becomes

**Changed files**
- `src/core/accounts.ts` — org identity + seed spec
- `src/agents/agent-tools/comms.ts` — new tool wrappers (reuse `outboundQualityGate`/`hitlGate`)
- `src/agents/capabilities.ts` — register tools + HITL set
- `src/agents/prompts/marketing.ts` — engagement + cadence workflows
- `src/infra/scheduler.ts` — cadence + sweep enqueue ticks
- `src/kernel/contracts.ts` — `EngagementResult` + `OUTPUT_CONTRACTS`
- `src/db/schema.ts` — `linkedin_events` table
- `src/infra/provider-config.ts` — org backend toggle
- `.env.example` / `docs/ops/ENV-VARS.md` — `LINKEDIN_ORG_URN`, `LINKEDIN_ORG_ACCESS_TOKEN`,
  `LINKEDIN_WEBHOOK_SECRET`, autonomy-mode flags, bumped `LINKEDIN_API_VERSION`

**Env / secrets:** org access token (60-day expiry, 365-day refresh — reuse account-registry
rotation), webhook signature secret, public webhook URL (deployment change).

---

## 7. Open decisions (need founder input before Phase 1)

1. **Company Page:** does a Turicks Company Page exist, or do we create one? (Phase 0 blocker —
   the org URN is the anchor for all engagement automation.)
2. **Autonomy defaults:** ship the table in §3, or start everything HITL-auto and graduate later?
3. **Watchlist source:** manual list of target profiles/companies, or derive from the sales/ICP
   pod's prospect scoring?
4. **Personal profile:** accept it stays post-only + draft-only-for-replies (r_member_social
   closed), or run a periodic re-check for LinkedIn reopening the scope?
```
