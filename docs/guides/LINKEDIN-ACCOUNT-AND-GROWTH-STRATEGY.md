# LinkedIn Account & Growth Strategy

**Purpose:** Who posts from which LinkedIn identity, what content wins followers, and how analytics feed the next draft.

**Audience:** Founder, marketing agent, anyone wiring LinkedIn tools.

**Last updated:** 2026-07-11

**Code:** `src/core/linkedin-posting-policy.ts`, `src/infra/social-mention.ts`

---

## Why two identities

GTM research (`docs/strategy/03-GTM-ACQUISITION-ENGINE.md`) shows **founder personal profiles get 5–10× reach** vs company pages for build-in-public. Turicks still needs a **company page** for official brand, showcases, and comment context.

| Identity | LinkedIn author | Use for | Goal |
|----------|-----------------|---------|------|
| **Pushkar personal** | `LINKEDIN_AUTHOR_URN_PERSONAL` (person URN) | Scheduled growth posts (Flow B) | Followers, inbound, founder credibility |
| **Turicks company page** | `LINKEDIN_AUTHOR_URN` = org URN | Immediate posts (A), engagement (comments/replies) | Brand, offers, official announcements |

Connection notes and outreach (Flow C) are **always personal** — LinkedIn does not send connection requests from company pages.

---

## Flow → account matrix

| Flow | Tool / path | Account | @Turicks tag | Content focus |
|------|-------------|---------|--------------|---------------|
| **A. Immediate post** | `linkedin_post` | Turicks **company page** | No | Official Turicks / showcase / offer |
| **B. Scheduled post** | `schedule_social_post` | Pushkar **personal** | **Yes** (default) | Build-in-public: problem solved with FounderOS |
| **C. Outreach note** | `src/outreach/` / `draft_connection_note` | Personal | No | Targeted connect notes (≤300 chars) |
| **D. Gap scanner** | `scan_ai_visibility` | N/A (research) | N/A | Prospect research only |
| **Engagement** | `linkedin_read_comments`, `draft_linkedin_reply` | Turicks page context | No | Reply on company posts |

Policy is **code, not prompt** — `resolveLinkedInPostingPolicy(flow)` in `linkedin-posting-policy.ts`.

---

## Flow B — scheduled growth posts (personal + @Turicks)

**Use when:** Cadence content to grow followers — weekly build logs, founder stories, “how I solved X.”

### Content formula (every scheduled post)

1. **Hook** — number, counterintuitive claim, or question (≤10 words).
2. **Problem** — specific pain (e.g. “our agent kept hallucinating sends”).
3. **Solution** — what you built on **FounderOS** / delivered via **Turicks** (concrete, not buzzwords).
4. **Outcome** — metric, lesson, or next step.
5. **CTA** — one ask (follow, comment, DM, GitHub star).
6. **@Turicks** — appended automatically unless founder disables `tag_company_page`.

### Pillars for scheduled cadence (priority)

1. **BUILD_LOG** — shipped features, test counts, real tool calls.
2. **FOUNDER_STORY** — behind-the-scenes, decisions, failures.
3. **AI_EDUCATION** — teach one concept you used in FounderOS.
4. **SHOWCASE** — only with `proof.turicks.com` or GitHub URL.

Avoid generic “excited to share” posts — they do not grow followers.

### Learn before you draft (analytics loop)

Before scheduling the next post, the marketing agent should:

```
linkedin_get_my_posts (limit 10)
  → linkedin_analytics per post_id
  → rank by reactions + comments
  → reuse winning hook + pillar in new draft
```

**Today:** agent tools wired (`linkedin_analytics` on marketing). Metrics depend on LinkedIn API scopes.

**Phase 2 (planned):** persist snapshots to Postgres, weekly cron summary to Telegram — see `docs/plans/2026-07-11-linkedin-growth-analytics-loop.md`.

---

## Flow A & engagement — Turicks company page

**Use when:** Founder says “post this now” as Turicks, or engages on **company page** comments.

- `linkedin_post` resolves `account_key: turicks` with author URN = **organization** URN.
- Brand + judge + HITL gates unchanged.
- Engagement tools assume posts live on the Turicks page feed.

---

## Environment setup

```bash
# Turicks company page (Flows A, engagement)
LINKEDIN_ACCESS_TOKEN=...
LINKEDIN_AUTHOR_URN=urn:li:organization:YOUR_ORG_ID

# Pushkar personal (Flow B scheduled)
LINKEDIN_ACCESS_TOKEN_PERSONAL=...          # same token if one OAuth app
LINKEDIN_AUTHOR_URN_PERSONAL=urn:li:person:YOUR_PERSON_ID

# @mention label (Flow B)
LINKEDIN_ORG_NAME=Turicks
LINKEDIN_ORG_URN=urn:li:organization:YOUR_ORG_ID   # optional; for future structured mentions
```

**Prod check:** `LINKEDIN_AUTHOR_URN` must be `urn:li:organization:…` for company-page posts. Personal URN on the turicks env var will publish to the wrong identity.

---

## Auto-correct & brand gates (already live)

Scheduled and immediate posts both pass:

1. **Brand validator** — banned phrases, hook, word count (auto-strip or retry).
2. **Judge** — tone / compliance (fail-open).
3. **HITL** — founder approves once.

Analytics **learning** is additive — it informs the *next* draft; it does not bypass gates.

---

## Verification

```bash
pnpm test tests/unit/core/linkedin-posting-policy.test.ts
pnpm test tests/unit/infra/social-mention.test.ts
```

**Manual:**

1. Set org URN on `LINKEDIN_AUTHOR_URN` → `linkedin_post` → confirm post appears on Turicks page.
2. When `schedule_social_post` ships on `main` → schedule 2 min ahead → confirm personal profile + `@Turicks` in text.

---

## Related docs

- [LINKEDIN-AUTOMATION-FLOWS.md](LINKEDIN-AUTOMATION-FLOWS.md) — E2E technical reference
- [03-GTM-ACQUISITION-ENGINE.md](../strategy/03-GTM-ACQUISITION-ENGINE.md) — channel priority
- [plans/2026-07-11-linkedin-growth-analytics-loop.md](../plans/2026-07-11-linkedin-growth-analytics-loop.md) — persisted analytics + cron
