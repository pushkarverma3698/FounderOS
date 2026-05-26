# FounderOS — Critique Rules
> Loaded by `criticNode` at runtime. Update this file to change quality standards.

## Universal Rules (all departments)
1. **No hallucinated facts** — every claim must be grounded in provided context
2. **No filler phrases** — "excited to share", "game-changer", "synergy", "circle back"
3. **Action-oriented** — every output must have a clear next step
4. **Length appropriate** — respect the max_tokens guidance for the tier
5. **Tone: direct and specific** — one concrete example beats three vague ones

## Sales Department
Rules for email/DM drafts reviewed by criticNode in sales pod:

- **Pain-first opening** — lead with their problem, not our capabilities
- **Specificity check** — must reference something specific about the prospect (post, product, funding)
- **No generic pitches** — "We help companies like yours" fails this rule
- **Word count** — outreach ≤ 150 words; proposals ≤ 500 words
- **Clear CTA** — one ask per message; no double CTAs
- **No attachment on first touch** — links to calendly only on second+ contact
- **Banned phrases**: "I wanted to reach out", "Hope this finds you well", "Just following up", "Quick question", "Touch base"

## Engineering Department
Rules for code and technical outputs:

- **No TODO comments** — implement the full solution
- **Type safety** — no `any` types; use proper TypeScript
- **Error handling** — all async functions must handle errors; no silent failures
- **Tests required** — every new function gets a test
- **Security** — no secrets in code; no SQL injection vectors; validate all inputs
- **Performance** — flag any N+1 queries, unbounded loops, or missing indexes

## Marketing Department
Rules for content drafts:

- **Hook on line 1** — must have number, counterintuitive claim, or direct question
- **Mobile-first formatting** — short paragraphs (1-3 lines max)
- **Authentic voice** — matches company brand profile (see registry.ts)
- **No stock phrases**: "excited to announce", "thrilled to share", "game-changing"
- **Emoji limit** — max 3 emojis per post
- **Length** — LinkedIn: 150-300 words; Instagram caption: 80-150 words

## APPROVED vs NEEDS_REVISION
- **APPROVED**: Output meets all department rules. Proceed to HITL.
- **NEEDS_REVISION**: One or more rules violated. State specific violations in `rule_violations[]`.
- **Escalation**: If revision_count ≥ max_revisions, send to HITL with escalation note regardless of critique result. Let the human decide.
