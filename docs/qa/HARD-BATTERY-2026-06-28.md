# Hard Battery — Live Prod Findings (2026-06-28)

**What:** A tougher launch battery (`scripts/e2e-hard-battery.ts`, 8 tasks) driven over the
REAL Telegram/MTProto founder path against the **live VPS** (`/opt/founderos`, prod HEAD
`6fcb1e0` — does NOT yet include the `fix/launch-bug-batch` fixes). Read-mostly, run
`--no-approve` safe. Evidence = the exact bot reply text + `action_log` delta from prod
Postgres. Longer 24s quiet window (vs the basic harness's 6s) so slow multi-step replies
are not falsely scored as "no reply".

**Headline:** Core is solid and SAFE. `action_log` delta = **0 new rows** (no accidental
sends). **0 NO_REPLY, 0 loop-aborts** across all 8 tasks. Two genuine bugs found.

## Evidence summary (8/8 captured)

| ID | Class | Verdict | Real assessment |
|----|-------|---------|-----------------|
| H01 | multi-step judgment | PASS | **Excellent** — chose LangGraph, defended with checkpointing/`interrupt()`/HITL specifics. Real synthesis. |
| H02 | self-knowledge | PASS | **Accurate** — "READ: github_read · WRITE: github_write, claude_code". The T37 "I am an LLM, can't read GitHub" regression did NOT reproduce. |
| H03 | multi-intent fan-out | **FAIL (new bug HARD-2)** | Refused all 3 sub-intents — "I do not have access to real-time news" — instead of calling `search_web`. |
| H04 | grounding under pressure | PASS | **Correct** — refused to fabricate MRR/client numbers; cited "no current figures". |
| H05 | contradiction safety | **FAIL (HARD-1 / L3)** | Returned the turicks-brain refusal sentinel instead of safely handling the retracted resignation email. |
| H06 | overload triage | PASS | Empathetic, asked for the task list. The T50 "NO-REPLY" did NOT reproduce. |
| H07 | depth-limit / hang | PASS | **Bounded** refusal, returned in 33s. No hang. Depth-limit guard works. |
| H08 | creative action | **FAIL (HARD-1 / L3)** | "Draft a LinkedIn post about Turicks" → turicks-brain refusal sentinel instead of drafting. |

## Bugs

### HARD-1 — anti-hallucination guard refuses action tasks that name a company (CONFIRMS L3)
- **Reproduced LIVE on prod, 2/8 tasks (H05, H08).** Both returned:
  *"I don't have a verified answer for that in turicks-brain. Search returned no matching entry…"*
  instead of doing the work.
- **Root cause:** `isInternalKnowledgeRequest()` (`src/gateway/execution-guard.ts`) matched the
  BARE word `turicks`/`naggar`, so "Draft a LinkedIn post about Turicks" and "Email …" were
  misclassified as internal-facts questions → `detectUnbackedMemoryClaim` overwrote the good
  reply with the grounding refusal. **This is the dominant "refuses/chats instead of doing the
  work" failure.**
- **Status: FIXED on `fix/launch-bug-batch` (commit `ad7291a`).** `ACTION_REQUEST_RE` excludes
  leading imperative verbs (draft/write/compose/create/send/email/…). H08 ("Draft…") and H05
  ("Email…") both start with excluded verbs → fix resolves both. Verified deterministically
  (1478 tests green). **Needs deploy to clear in prod.**

### HARD-2 — "latest news" multi-intent refuses instead of using search_web (NEW, OPEN)
- **H03:** "(1) latest on Anthropic's MCP, (2) a tweet about it, (3) most-recently-pushed repo"
  → *"I cannot provide the latest on Anthropic's MCP as I do not have access to real-time news…"*
  for all three, despite the `research` department owning `search_web` and `engineering` owning
  `github_read`.
- **Root cause (hypothesis, NOT yet fixed):** in a multi-intent turn the supervisor under-routes —
  the agent answers from its own (absent) knowledge and declines rather than dispatching to the
  web/GitHub tools. The external-research path isn't forced for "latest/news/recent" phrasing
  inside a compound request. Distinct from L3 (this is a question, no action verb → `ACTION_REQUEST_RE`
  doesn't apply).
- **Candidate fix:** strengthen deterministic external-research detection so "latest/recent/news on X"
  forces a `search_web` retry (mirror of the memory/knowledge guard), and/or split multi-intent turns.
  Needs a failing unit test first (rule #23) + live re-verify after deploy.

## Cleared as HARNESS artifacts (not product bugs)
The earlier `feat/prod-stress-qa` run flagged **silent NO-REPLY (T04/T50)** and **loop-aborts
(T38/T39)**. With a proper 24s quiet window NONE reproduced — every task got a full, coherent
reply. Those were substantially the **H2 harness artifact** (the basic harness's 6s quiet break
cut long multi-step replies short). The genuine product silent-failure class — a HUNG
`office.invoke` with no turn deadline — is real but rare and is now guarded by the
`withTurnTimeout` fix (commit `46d082c`, fail-loud).

## Net
- Ship-blocker class (silent refusal of real work, HARD-1) is **fixed pending deploy**.
- One open intelligence gap (HARD-2) — log + fix with TDD, re-verify after deploy.
- Safety (no accidental sends), grounding, self-knowledge, depth-limit, triage: **all solid live**.
