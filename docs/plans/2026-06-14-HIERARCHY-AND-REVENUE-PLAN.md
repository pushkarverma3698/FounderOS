# FounderOS Complete Documentation Update Plan

**Date:** 2026-06-14  
**Status:** Planning  
**Scope:** Comprehensive documentation overhaul for Phases 1-6 hardening + current operational features

---

## CONTEXT

FounderOS has undergone significant changes since the v2 rebuild (2026-06-01):

- **Phase 1-5 hardening** merged to `main` (PR #70, 2026-06-14): context isolation, typed contracts, Claude-as-judge, dept signals, hierarchy proof
- **Phase 6** partially documented: CLAUDE.md rules #20-21 exist but are scattered, not cross-referenced
- **Current state:** ADRs are comprehensive (025 total), but operational guides are missing for:
  - How to use new features (signals, judge, contracts)
  - How to operate memory system (turicks-brain/personal-rag)
  - Which tools require HITL approval and why
  - How to verify hardening is working in production

**Problem:** Code has advanced faster than docs. A new operator or contributor landing on the repo cannot:
- Understand what Phases 1-6 accomplished
- Know when to use `publish_signal` vs direct agent response
- Verify context isolation is working
- Troubleshoot memory system issues
- Know which 11 tools are HITL-gated and why

**Solution:** Comprehensive documentation refresh covering:
1. Update stale references in CLAUDE.md
2. Create Phase 1-6 delivery documentation
3. Write operational guides for major features
4. Add troubleshooting sections
5. Regenerate knowledge graph

---

## IMPLEMENTATION PLAN

### PHASE A: CRITICAL UPDATES (Unblock production trust)

#### A1. Update CLAUDE.md (Line 58 + Rules 21-25)
**File:** `/Users/pushkarverma/Projects/founderos/CLAUDE.md`

**Changes needed:**
1. Line 58: Change "3 ReAct departments" → "7 ReAct departments (research, comms, engineering, marketing, sales, personal, jobhunt)"
2. After rule #19 ("test the REAL path"), add rules 20-21:
   - **Rule #20: Context isolation** — no leakage across graph boundaries. Link to ADR-021, implementation details (outputMode:"last_message", trim suffix not prefix, measured not claimed)
   - **Rule #21: Typed inter-dept handoffs** — all cross-boundary data via typed contracts. Link to ADR-022, `validateSignalPayload()`, generator≠critic
3. Update "Current Phase Status" section to reflect Phases 1-6 are SHIPPED (not Phase C only)

**Time:** 30 min  
**Verification:** tsc clean, CLAUDE.md section reads correctly

---

#### A2. Create PHASE-HARDENING-GUIDE.md
**File:** `/Users/pushkarverma/Projects/founderos/docs/guides/PHASE-HARDENING-GUIDE.md`

**Content structure:**
- Overview: "What are Phases 1-6? Why hardening?"
- Phase 1 (Context Isolation, ADR-021)
  - Goal
  - What changed
  - How to verify in code (outputMode, seam tracing)
  - How to spot leakage (logs to search)
  - Production observation
- Phase 2 (Typed Contracts, ADR-022)
  - Goal: deterministic validation
  - Contract types (lead_discovered, proposal_approved, demo_ready)
  - validateSignalPayload() function
  - Failure modes + edge cases
- Phase 3 (Judge, ADR-023)
  - Goal: quality gate on outbound copy
  - Two-gate system (brand-validator → Claude judge)
  - How to interpret judge feedback
  - When to skip (fail-open semantics)
- Phase 4 (Signals, ADR-024)
  - Goal: durable cross-department communication
  - publish_signal tool + dept_signals table
  - Hourly sweep semantics (exactly-once)
  - Current event types: lead_discovered, proposal_approved, demo_ready
- Phase 5 (Hierarchy, ADR-025)
  - Goal: nested HITL support for complex orgs
  - revenue-domain.ts example (NOT in production yet)
  - 3-level interrupt/resume verified
  - Gate: business trigger + MTProto verification required
- Phase 6 (Rules, no ADR yet)
  - Rules #20-21 operationalized in code

**Cross-references:**
- Link each phase to its ADR
- Link to verification sections (tests, seams)
- Link to observability (trace_callback, budget_tracker)

**Time:** 1 hour  
**Verification:** Links work, code examples extracted from actual files

---

#### A3. Create HITL-MATRIX.md
**File:** `/Users/pushkarverma/Projects/founderos/docs/guides/HITL-MATRIX.md`

**Content:**
| Tool | Department | Type | Gate Pattern | Why HITL? |
|------|-----------|------|--------------|-----------|
| send_email | comms, sales | External write | Full gate | Sender reputation, CAN-SPAM compliance |
| linkedin_post | marketing | External write | Gate 1 (brand) → Gate 2 (judge) | Brand safety, regulatory risk |
| github_write | engineering | External write | Full gate | Account security, production impact |
| project_workflow | engineering | External action | Full gate | CI/CD triggers, deployment risk |
| claude_code | engineering | Local execution | Full gate | Arbitrary shell/git execution |
| create_calendar_event | comms | External write | Full gate | Calendar namespace collision |
| write_file | personal | Local write | Full gate | Arbitrary file modification |
| run_shell | personal | Local execution | Full gate | Arbitrary shell execution |
| send_file | personal | External send | Full gate | File exfiltration risk |
| browser | personal | Local automation | Full gate | Arbitrary browser automation |
| read_emails | comms | External read | **NO gate** | Read-only, instant execution |

**Additional columns:**
- Escalation path (who approves)
- Failure behavior (what happens if rejected)
- Observability (where it logs)

**Time:** 20 min  
**Verification:** Cross-reference with agent-tools.ts, mark all HITL-gated tools

---

### PHASE B: FEATURE GUIDES (Unblock operators)

#### B1. Create SIGNALS-AND-CONTRACTS.md
**File:** `/Users/pushkarverma/Projects/founderos/docs/guides/SIGNALS-AND-CONTRACTS.md`

**Content:**
1. What are dept signals?
   - Async inter-department communication pattern
   - Exactly-once guarantee via Postgres
   - Published → Persisted → Consumed (hourly)
   - Never auto-executed (surfaces work, doesn't execute)
2. Current signal types (from contracts.ts):
   ```
   - lead_discovered: { context: string, prompt: string, payload: any }
   - proposal_approved: { context: string, prompt: string, payload: any }
   - demo_ready: { context: string, prompt: string, payload: any }
   ```
3. How to publish:
   - Call `publish_signal(event_type, payload)`
   - Payload must match contract schema
   - Returns { success, signal_id }
4. How to consume:
   - Cron job `sweepDeptSignals` (hourly)
   - Reads from dept_signals table
   - Validates with `validateSignalPayload()`
   - Surfaces to Telegram (creator decides action)
5. How to add new signal types:
   - Define Zod schema in contracts.ts
   - Add to SIGNAL_CONTRACTS registry
   - Update test to enforce registry parity
   - Update this doc

**Time:** 45 min  
**Verification:** Extract from contracts.ts + agent-tools/signals.ts, test cross-references

---

#### B2. Create JUDGE-AND-CRITIC.md
**File:** `/Users/pushkarverma/Projects/founderos/docs/guides/JUDGE-AND-CRITIC.md`

**Content:**
1. What is the judge pattern?
   - Phase 3 implementation: deterministic first pass + LLM second pass
   - Gate 1: brand-validator (banned phrases, word count, no LLM)
   - Gate 2: Claude judge (critique-only, fail-open)
2. When it activates:
   - linkedin_post tool: draft → judge → HITL approval
   - Other send tools: similar pattern (email, calendar, etc.)
3. How the judge works:
   - Reads `JUDGE_PROMPT` from src/infra/judge.ts
   - Evaluates for tone, clarity, brand voice, compliance
   - Returns critique object: `{ passed: bool, violations: string[], guidance: string }`
   - Fail-open: if ANTHROPIC_API_KEY missing → no-op pass
   - Memoized: same draft within 1 hour reuses prior judgment
4. What the judge checks:
   - Brand voice alignment (Turicks tone)
   - Clarity + readability
   - Compliance (no phishing language, no deceptive claims)
   - Length (within bounds)
5. Interpreting judge feedback:
   - `violations: []` → clean, no changes needed
   - `violations: ["...", "..."]` → fix and resubmit
   - `guidance: "..."` → contextual advice on how to fix
6. When to skip judge:
   - Already HITL-approved drafts can bypass if founder confirms
   - Edge case: time-sensitive comms (fail-open ensures no blockage)

**Time:** 45 min  
**Verification:** Extract from src/infra/judge.ts + linkedin_post tool

---

#### B3. Create MEMORY-OPERATIONS.md
**File:** `/Users/pushkarverma/Projects/founderos/docs/guides/MEMORY-OPERATIONS.md`

**Content:**
1. Memory system overview:
   - turicks-brain: business/portfolio knowledge (Postgres + pgvector)
   - personal-rag: career/personal knowledge (Postgres + pgvector)
   - episodic_memory: decision + outcome logs
   - Separation boundary: ADR-013, never cross-write
2. Populating turicks-brain:
   - `pnpm brain:sync` after adding/editing docs in docs/
   - Reads `docs/decisions/`, `docs/phases/`, `docs/superpowers/specs/`
   - Upserts to knowledge_entries table
   - Indexed by pgvector embeddings (Ollama nomic-embed-text)
3. Populating personal-rag:
   - Manual: `cd ~/Projects/personal-rag && python scripts/ingest_local_docs.py`
   - Reads local CV, resume, portfolio docs
   - Separate Postgres instance (different DB)
4. Querying memory:
   - `search_knowledge(query)` → turicks-brain keyword + semantic
   - `search_personal_rag(query)` → personal-rag keyword + semantic
   - Both support top_k limit (default 5)
5. Troubleshooting:
   - "search_knowledge returns nothing"
     - Check: docs/decisions exist? Run `pnpm brain:sync`?
     - Check: Postgres up? pgvector extension loaded? (`SELECT * FROM pg_extension WHERE extname='vector'`)
     - Check: knowledge_entries table has rows? (`SELECT COUNT(*) FROM knowledge_entries`)
   - "Results are stale"
     - Run `pnpm brain:sync` again (idempotent, safe)
     - Check last_synced timestamp in knowledge_entries
   - "Hits are too generic"
     - Current system uses ILIKE keyword match (not semantic)
     - Semantic search (Chroma migration) deferred (ADR-005)
6. Current limitations:
   - Keyword-based only (no semantic relevance ranking)
   - Max 5 results per query (truncated, no continuation)
   - No faceted search (can't filter by content type)
   - All documents indexed together (no tenant separation)
7. Future roadmap:
   - Migrate to Chroma for semantic search
   - Add relevance ranking
   - Support multi-tenant isolation (Phase E)

**Time:** 1 hour  
**Verification:** Test brain:sync locally, trace search_knowledge implementation

---

### PHASE C: OPERATIONAL GUIDES (Unblock troubleshooting)

#### C1. Create SECURITY-RULES-20-21.md
**File:** `/Users/pushkarverma/Projects/founderos/docs/guides/SECURITY-RULES-20-21.md`

**Content:**
1. Rule #20: Context Isolation
   - What it prevents: dept A seeing dept B's internals
   - How it works: `outputMode: "last_message"` in office.ts
   - How to verify:
     - Check: office.ts line 142 has `outputMode: "last_message"` pinned ✓
     - Check: supervisor sees NO tool_use/tool_result messages, only final replies
     - Monitor: trace_callback logs each seam; search for tool_use → should only appear within dept, never cross-supervisor
   - Failure symptoms:
     - Supervisor message history leaks internal tool calls
     - Departments see each other's intermediate reasoning
     - Token budget explodes (trimmed history becomes huge)
   - How to audit:
     - Enable trace logging: `TRACE_ENABLED=1`
     - Run a task
     - Check logs: `grep "seam:supervisor" founderos.log`
     - Should see: `turn.in → route.decided → dept_name.invoke → turn.out` (clean boundary)
     - Should NOT see: `supervisor.invoke` containing internal tool_use

2. Rule #21: Typed Inter-Department Handoffs
   - What it prevents: undefined/unexpected signal payloads crashing workflows
   - How it works: `validateSignalPayload()` in agent-tools/signals.ts
   - How to verify:
     - Check: contracts.ts has SIGNAL_CONTRACTS Zod schemas ✓
     - Check: test enforces registry parity (parity_test.ts)
     - Monitor: logs show `validateSignalPayload` result (pass/fail) for every signal
   - Failure symptoms:
     - publish_signal rejects valid-looking payloads (wrong schema)
     - sweepDeptSignals silently skips malformed signals (check logs)
     - New signal types cause test failures (registry parity gap)
   - How to add a signal type:
     1. Define Zod schema in contracts.ts
     2. Add to SIGNAL_CONTRACTS
     3. Run tests (parity enforced, catches mismatches)
     4. Deploy + monitor logs for validation results

3. Monitoring both rules:
   - Use trace callback: every seam logged, every validation checked
   - Set up alerts: seam-cross-boundary warnings in logs
   - Test coverage: unit tests for context isolation (office-guard.ts) + signal validation

**Time:** 45 min  
**Verification:** Extract from office.ts, contracts.ts, trace_callback.ts

---

#### C2. Expand OPERATIONS.md
**File:** `/Users/pushkarverma/Projects/founderos/docs/guides/OPERATIONS.md`

**Additions:**
1. Add section: "Halt & Resume" (kill switch)
   - When to use: critical bug, security incident, service degradation
   - How: `POST /halt` (writes halt.blocked file)
   - Effect: next request checks halt.blocked, aborts gracefully
   - Resume: `POST /resume`
   - Test: `scripts/probe-halt.ts` verifies behavior
2. Add section: "Monitoring Signals"
   - Where to check: `SELECT * FROM dept_signals` (Postgres)
   - What to look for: unprocessed signals (consumed=false), failed validations
   - Trigger manual sweep: `scripts/sweep-dept-signals.ts` (if needed)
3. Add section: "Quota & Budget"
   - Where it's tracked: `budget_tracker` logs every turn
   - Fields: inputTokens, outputTokens, modelCost, totalCost
   - Per-dept limits: configured in src/core/config.ts (COST_LIMITS)
   - How to adjust: update config, restart bot
   - Check usage: query `turn` table grouped by dept_name
4. Add section: "Scheduler Jobs"
   - What runs: weekly digest (Monday 6am), signal sweep (hourly)
   - Where configured: src/infra/scheduler.ts
   - How to add a new schedule: same pattern, register in index.ts
   - Test: `scripts/test-scheduler.ts`
5. Add troubleshooting subsections:
   - "Bot not responding" → check halt.blocked, check Postgres, check Telegram token
   - "Signals not consuming" → check Postgres (SELECT COUNT(*) FROM dept_signals WHERE consumed=false)
   - "High token cost" → run `SELECT SUM(modelCost) FROM turn` by dept
   - "Memory searches empty" → run `pnpm brain:sync` + check knowledge_entries count

**Time:** 1 hour  
**Verification:** Test each new subsection against actual scripts + config

---

### PHASE D: MISSING DELIVERABLE DOCS (Close gaps)

#### D1. Create PHASE-[1-6]-DELIVERY.md files
**Files:** `docs/phases/PHASE-1-CONTEXT-ISOLATION.md` through `PHASE-6-RULES.md`

**Template (apply to each phase):**
```markdown
# Phase [N] — [Name]

## Goal
[1 sentence]

## Delivered
- [Concrete change to code]
- [Test coverage added]
- [Observability added]

## Verification
- [How to check it's working]
- [Test files]
- [Production evidence]

## Decision Record
[Link to ADR]

## Gotchas
- [Known issue if any]
- [Workaround if needed]
```

**Content per phase:**

1. **PHASE-1-CONTEXT-ISOLATION.md**
   - Delivered: outputMode:"last_message" pinned in office.ts, per-turn token logging
   - Verification: office-guard.ts tests, trace_callback logs
   - Gotcha: Nested supervisors must also use "last_message" (revenue-domain.ts example)

2. **PHASE-2-TYPED-CONTRACTS.md**
   - Delivered: contracts.ts with 3 event types, validateSignalPayload()
   - Verification: contracts.test.ts (parity + validation)
   - Gotcha: Adding signal types requires updating registry + tests

3. **PHASE-3-CLAUDE-JUDGE.md**
   - Delivered: src/infra/judge.ts, fail-open, memoized
   - Verification: judge.test.ts, linkedin-post integration
   - Gotcha: Requires ANTHROPIC_API_KEY (if missing, no-op pass)

4. **PHASE-4-DEPT-SIGNALS.md**
   - Delivered: publish_signal tool, dept_signals table, hourly sweep
   - Verification: signals.test.ts, sweepDeptSignals integration
   - Gotcha: Surfaces work, doesn't auto-execute; founder decides action

5. **PHASE-5-HIERARCHY-PROOF.md**
   - Delivered: revenue-domain.ts (proof of nested HITL)
   - Status: Code complete, NOT in production (gated on trigger + verification)
   - Verification: hierarchy.test.ts (3-level interrupt/resume)
   - Gate: Requires business trigger + MTProto verification before promoting

6. **PHASE-6-RULES.md** (no ADR yet)
   - Delivered: Rules #20-21 operationalized (CLAUDE.md + code)
   - Verification: SECURITY-RULES-20-21.md, context isolation audit
   - Gotcha: Both rules are structural (not enforceable at compile time); need observability

**Time:** 2 hours (30 min per phase)  
**Verification:** Cross-reference ADRs, link to code, verify tests pass

---

#### D2. Create PHASE-D-REVENUE-FLYWHEEL.md
**File:** `/Users/pushkarverma/Projects/founderos/docs/phases/PHASE-D-REVENUE-FLYWHEEL.md`

**Content:**
1. Goal: Generate revenue + authentic portfolio signals
2. Deliverables:
   - Gumroad packs live (product pages)
   - LinkedIn launch sequence (scripted outreach)
   - Cinematic-web done-for-you tier (new GTM motion)
   - Weekly outbound rhythm (scheduled follow-ups)
3. Success criteria:
   - 1st revenue transaction by 2026-07-XX
   - 3+ credible portfolio demos shipping
   - 20+ qualified inbound meetings
4. Gate for Phase E:
   - 4-6 weeks of reliable autonomous operation
   - <1% failure rate across departments
   - All observability seams live
5. Timeline:
   - Week 1: Gumroad packs live + landing pages
   - Week 2: LinkedIn templates + first batch
   - Week 3: Cinematic tier soft launch
   - Week 4+: Weekly outbound, measure ROI

**Time:** 30 min  
**Verification:** Cross-reference with ROADMAP.md

---

### PHASE E: KNOWLEDGE GRAPH REGENERATION

#### E1. Regenerate .claude/graph.json
**Command:** `npx tsx scripts/generate-knowledge-graph.ts`

**Why:** Current graph still lists `dept_prospecting` (merged into research in Phase B)

**Time:** 2 min (automation + commit)  
**Verification:** Verify no `dept_prospecting` node in output

---

### PHASE F: INTEGRATION & CROSS-REFERENCES

#### F1. Update docs/README.md index
**Changes:**
- Add new guides to the index (PHASE-HARDENING-GUIDE, HITL-MATRIX, SIGNALS-AND-CONTRACTS, JUDGE-AND-CRITIC, MEMORY-OPERATIONS, SECURITY-RULES-20-21)
- Update guides/ table with new entries
- Link PHASE-[1-6]-DELIVERY docs in phases/ section

**Time:** 15 min  
**Verification:** All links resolve, structure is scannable

---

#### F2. Update LIMITATIONS.md
**Additions:**
- Current limitations in memory system (keyword search only, not semantic)
- Eval harness limitations (golden tasks hardcoded)
- Signal system limitations (no auto-execution, manual review required)
- Judge limitations (fail-open, not a blocker)

**Time:** 20 min  
**Verification:** Honest limitations, not aspirational claims

---

#### F3. Update PR template (.github/pull_request_template.md)
**Addition:**
- Checklist item: "Docs updated per CLAUDE.md rule #18 (memory as source of truth)"
- Links to which docs to update based on change type

**Time:** 10 min  
**Verification:** Template renders correctly on test PR

---

## TOTAL EFFORT & TIMELINE

| Phase | Tasks | Effort | Cumulative |
|-------|-------|--------|-----------|
| **A: Critical** | A1-A3 | 2 hrs | 2 hrs |
| **B: Features** | B1-B3 | 2.5 hrs | 4.5 hrs |
| **C: Operations** | C1-C2 | 2 hrs | 6.5 hrs |
| **D: Deliverables** | D1-D2 | 2.5 hrs | 9 hrs |
| **E: Graph** | E1 | 0.25 hrs | 9.25 hrs |
| **F: Integration** | F1-F3 | 1 hr | 10.25 hrs |

**Total: ~10 hours** (1 day focused work, or 2 days with testing)

---

## EXECUTION ORDER

1. **A1** — CLAUDE.md fixes (highest priority, unblocks understanding)
2. **A2, A3** — PHASE-HARDENING-GUIDE + HITL-MATRIX (foundation for operators)
3. **B1-B3** — SIGNALS, JUDGE, MEMORY guides (feature understanding)
4. **C1-C2** — SECURITY-RULES + OPERATIONS updates (troubleshooting)
5. **D1-D2** — Phase delivery docs + PHASE-D (completeness)
6. **E1** — Graph regen (hygiene)
7. **F1-F3** — Integration + cross-references (finalizing)

---

## VERIFICATION CHECKLIST

- [ ] All new docs follow the template structure from existing docs
- [ ] All cross-references work (links are valid)
- [ ] All code examples extracted from actual source (not invented)
- [ ] All test files referenced exist and pass
- [ ] No dead links in README.md index
- [ ] CLAUDE.md reads coherently with all 21 rules documented
- [ ] Phase docs follow same structure as PHASE-C-INTELLIGENCE.md
- [ ] Graph.json regenerated and committed
- [ ] PR template updated with checklist items
- [ ] All docs mention observability/verification (not aspirational)

---

## SUCCESS CRITERIA

After this update:
- ✅ New operator can land, read README → ARCHITECTURE → guides in order, understand the system
- ✅ Phases 1-6 hardening is documented (not just ADRs, but operational guides)
- ✅ All 11 HITL-gated tools are explained (why, when, how to approve)
- ✅ Memory system is troubleshootable (query examples, common failures, fixes)
- ✅ Production operator can run the system without relying on chat history
- ✅ All decision records have corresponding "how this appears in code" sections
- ✅ Feature gaps are closed (signals, judge, contracts, scheduler, quota)
