# ADR-009: LinkedIn Automation — Defer Until Ban-Risk Research Complete

**Status:** DEFERRED  
**Date:** 2026-06-01  
**Context:** Phase 3A / 1-week sprint decision

---

## Decision

LinkedIn outreach automation via the LinkedIn API is **deferred indefinitely** until a dedicated ban-risk research pass completes and an explicit safe-automation architecture is approved.

No LinkedIn API outreach code ships into production FounderOS on the current sprint.

The `social_linkedin` agent registered in Phase 3A uses Composio OAuth for **content posting only** (build log / thought leadership posts) — this is categorically different from automated connection requests, InMails, or sequential messaging, which trigger ban risk.

---

## Context

During sprint planning (ADR-008), the decision was made to defer LinkedIn automation (Option A) because:

1. **Account ban risk is real and immediate.** LinkedIn's anti-automation systems detect:
   - Sequential connection requests at non-human speeds
   - Cookie-based automation (Phantombuster, browser extensions) without their official API
   - Official API outreach at scale without a pre-approved Marketing Solutions contract
   - Rapid messaging patterns (>50 InMails/day)

2. **The LinkedIn Partner Program API** (the only officially supported path for outreach automation) requires:
   - A Marketing Partner application (weeks-long approval process)
   - Minimum spend commitments tied to Campaign Manager
   - Specific use-case approval — not blanket "send messages on behalf of user"

3. **Third-party tools (Phantombuster, Expandi, Waalaxy)** operate via browser session injection, not official API. LinkedIn actively detects and bans:
   - IP addresses associated with automation farms
   - Accounts sending > 20-30 connection requests/day
   - Accounts with abnormal engagement ratios

4. **The Turicks account is the primary business development channel.** A ban would halt outbound for days to weeks — unacceptable for a solo founder operating system.

---

## Options Considered

### A: Use unofficial browser automation (Phantombuster / session injection)
- **Risk:** High. Account ban probability ~30% within 90 days at any meaningful volume. LinkedIn's bot detection improves quarterly.
- **Verdict:** Rejected. Risk/reward unfavorable when Turicks is the only outbound channel.

### B: Build on LinkedIn Official API (Marketing Developer Platform)
- **Risk:** Low (if approved). **Timeline:** 4-8 weeks for partner approval. **Cost:** Campaign Manager spend commitment.
- **Verdict:** Viable long-term path. Blocked on: (a) partner program application, (b) determining whether solo founder qualifies.
- **Action required:** Submit Marketing Developer Platform application and track.

### C: Composio LinkedIn integration (current social_linkedin agent)
- **Scope:** Content posting only (Composio uses official OAuth scopes: `w_member_social`).
- **Risk:** Low for posting. `w_member_social` does NOT include messaging or connection requests.
- **Verdict:** Ship this. Content posting builds audience passively — zero ban risk.
- **Status:** Already implemented in Phase 3A (`social_linkedin` agent + `composio_linkedin_post` tool).

### D: Defer entirely + manual outreach
- **Verdict:** Current default. Manual LinkedIn DMs sent by Pushkar himself, using the ICP scoring output from the prospecting pod as a decision aid.

---

## Resolution Criteria

This ADR closes and LinkedIn automation can be re-evaluated when **all of**:

1. [ ] Marketing Developer Platform application submitted and status tracked
2. [ ] Ban-risk analysis: review 10+ case studies of agencies that were banned + their pattern of use
3. [ ] Safe volume benchmarks established: connections/day, InMails/day, messaging cadence
4. [ ] Architecture review: how to make LinkedIn automation crash-safe + account-recoverable
5. [ ] Warm-up period plan: account age, post history, connection count minimums before automation starts

---

## Current State

| Feature | Status | Notes |
|---------|--------|-------|
| LinkedIn content posting | ✅ SHIPPED | social_linkedin agent via Composio `w_member_social` |
| LinkedIn connection requests | ⛔ BLOCKED | Ban risk — pending Option B |
| LinkedIn InMail / messaging | ⛔ BLOCKED | Ban risk — pending Option B |
| LinkedIn prospecting (read) | ✅ SAFE | Manual research, ICP scoring pod handles this |

---

## References

- ADR-008: Ship website-builder + Gumroad, defer LinkedIn
- `src/agents/pods/social.ts` — social_linkedin posting agent (safe, shipped)
- `src/tools/linkedin.ts` — Composio post/reply tools (post-only scope)
- LinkedIn Developer Platform: https://developer.linkedin.com/product-catalog
