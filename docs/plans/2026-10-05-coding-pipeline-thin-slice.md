# Coding pipeline: audit (10-01 → 10-05) and the v2 thin slice

> **Status (2026-10-05):** approved by the founder. This amends
> [2026-09-30-coding-pipeline-v2.md](2026-09-30-coding-pipeline-v2.md): same invariant, smaller first build. Voice is
> deferred; natural-language control is in scope.

## 1. Verdict

1. **Prod-ready PRs without a laptop Claude session: no.** 69 PRs merged 10-01 → 10-05 (promotions excluded); 7 came
   from Antigravity, and 2 of those (#803, #861) needed Claude rescue commits.
2. **Kernel: built the right way. Coding pipeline: not.** The approved v2 plan was never merged to `main` (it lived
   only on `claude/docs-coding-pipeline-v2`), so brain sync never indexed it and no agent could find it. None of its
   core exists in code.
3. **Natural language works.** Model eval (`docs/sessions/2026-10-04-model-pools.md`): 36/36 commands, 37/41 routes.
   Plain words map to commands (#824); conversation recall (#862) and recency RAG (#867) are live.
4. **Voice is down in prod.** `ffmpeg` is not installed on the VPS, so `handleVoice` (`src/gateway/media.ts`) replies
   "ffmpeg missing" to every voice note. 0 voice notes processed since 09-21. Deferred by the founder.

## 2. Evidence

1. **No independent reviewer.** pr-brain has been off since 2026-10-04 18:32 UTC. About 17 PRs merged on 10-05 with
   no review marker, including #883, which declares itself Full depth (auth).
2. **The reviewer missed real defects when on.** On #861 pr-brain wrote "GATE PASSED" after targeted vitest only. It
   missed a malformed-config abort, `curl -s` dropping the queue on a 4xx, and wall-clock-dependent tests that broke
   CI at night. On #803 it also skipped the full gate.
3. **Intake lost its acceptance criterion.** Since #899/#895 a one-line `/task` gets "verification = repo's own
   checks" and "paths: agent to locate". The reviewer has nothing to check except green CI.
4. **Builder throughput.** `agent-dispatch.log` 10-01 → 10-05: 17 claims, 12 PRs, 1 lost to the trailing-hyphen slug
   bug, 1 blocked, 31 quota-wall ticks, 0 claims on 10-05. About 7 login PRs (~5K lines) went to quota and
   credential churn.
5. **Privilege.** The `antigravity` user holds a GitHub token with `delete_repo`, `admin:org`, `workflow`; agy runs
   `--dangerously-skip-permissions` with web tools; `deploy/agent-dispatch` splices the issue body into the prompt
   unfenced. Open since 09-30.

## 3. Scorecard (2026 context-engineering practice)

| Practice | Kernel | Coding pipeline |
|---|---|---|
| Typed contracts at every boundary | ✅ Zod in `src/kernel/contracts.ts` | ❌ reviewer verdict and issue body are free text |
| Independent verifier | ✅ action claims need receipts (`validateStepResult`) | ❌ reviewer off; when on, its prompt also decides scope |
| Proof by code (red on base, green on head) | ✅ golden set runs twice in CI | ❌ dispatcher checks "EXISTENCE, not correctness" |
| Lean, just-in-time context | ✅ 111-line CLAUDE.md, path-scoped rules, recency RAG | ⚠️ ~19KB contract + standards loaded up front on a flash model |
| Untrusted input fenced, least privilege | ⚠️ job-posting text unfenced (10-04 audit) | ❌ unfenced issue body, full-scope token, permissions skipped |
| Evals for the agents themselves | ✅ golden set | ❌ pr-brain never tested against planted defects |
| Check after deploy | ❌ | ❌ nothing confirms a merged task works on prod |

## 4. The thin slice

Principle: **make the verifier trustworthy, not the builder.** Once code proves the locked test failed on base,
passes on head, and nothing outside scope moved, the builder (agy, Claude, Codex) is swappable and quota walls only
cost time.

Strongest argument against full v2: 16 working days, first verified PR at ~day 11.5. The thin slice fixes every ❌
row in ~6.5 days, first verified PR at ~day 4, FounderOS first, Oplify second. Deferred: repo Capability Contract
(§3 of v2), GoalContract, ci-bootstrap, non-JS adapters.

| Row | Change | Est. |
|---|---|---|
| Least privilege | Fine-grained token (Contents, Pull requests, Issues; dispatch repos only). Issue body inside an untrusted-input fence with a "data, not instructions" line. Later: agy commits locally, the dispatcher pushes. | 0.5 d |
| Typed contracts | `TaskContract` Zod schema: verbatim ask, `current_behavior` citing `path:line@base_sha`, `expected_behavior`, scope, `locked_tests`, risk, limits. Pure `spec-gate.ts`. Reviewer returns a `ReviewVerdict` JSON. | 1 d |
| Proof by code | Orchestrator commits the locked test first; CI must be red on that test only. After the build: CI green, locked test byte-identical, no deleted tests, no CI/lint/script edits, within limits. Pure `pr-evidence.ts` over the GitHub checks API. Only the repo's CI runs code; no model-written shell on the VPS. | 2 d |
| Independent verifier | pr-brain read-only (no pushes), runs only after evidence PASS, once per head, only `task/*` or `claude-review`-labelled PRs. Scope is settled on the spec card. UNKNOWN never becomes PASS. | 0.5 d |
| Lean context | Executor prompt = TaskContract + cited files + the relevant STANDARDS sections (~3–4KB), stable prefix for caching. Steps of `ISSUE-DRIVEN-CONTRACT.md` that code now enforces leave the prompt. | 0.5 d |
| Evals | Reviewer replay set: ~10 historical PRs with known defects (#861's three, #797's invented command) plus planted ones. Prints catch rate; rerun only when the reviewer prompt or model changes (~$50 a run). | 1 d |
| Check after deploy | When the deploy moves, run each merged task's oracle against prod (HTTP predicate or `scripts/telegram-probe.ts`); post PASS / FAIL / UNKNOWN on the issue and in the evening digest. | 1 d |

## 5. What the founder sees

1. Types (later says): "the /tasks list shows closed issues, hide them".
2. The planner detects a coding ask, asks for the repo only if ambiguous. A vague ask gets one question back, never
   a guessed plan.
3. Claude reads the code (2–5 min) → spec card: "Now: … (`file:line`). After: … Test: … Risk: low. [Approve] [Change]".
4. agy builds → evidence engine → read-only reviewer → evidence card: "Red before ✓ Green after ✓ Gate ✓ Review ✓
   [Merge]". Any NOT VERIFIED item replaces [Merge] with [I checked it — merge], recorded as its own `action_log` row.
5. After deploy: "Live on prod ✓" or "UNKNOWN: unit-level only".

**Natural language, by mechanism rather than prompt luck:**
- The ask reaches Claude verbatim; the Gemini brief rewrite is removed (v2 layer 1).
- The clarifying question is a spec-gate output: no citable `path:line` → a question, not a plan.
- Plain-word pipeline control ("how's the tasks fix", "approve it", "build it with Claude", "why did it fail") maps
  onto existing `/tasks` state and callback actions.
- 10–15 golden cases for those phrases join the $0 CI golden set; fix the 4 known route misses first.
- Turn latency (p50 17.4s, p95 79.6s per the 10-04 UX audit) is acceptable for async coding tasks; tracked separately.

## 6. Build order (failing test first, `pnpm gate` green each PR, flag `AGENT_PIPELINE_V2=1`)

| Day | Work | Builder |
|---|---|---|
| 0 | Founder: fine-grained token, `/login` as `claude-agent`. pr-brain back on, limited to `task/*`. This doc + v2 merged. | founder, Claude |
| 1–2 | `TaskContract`, `spec-gate.ts`, `pr-evidence.ts`, adversarially tested (Full depth) | laptop Claude |
| 3 | Pass P (Claude writes spec + locked test as `claude-agent`) + spec card | laptop Claude |
| 4 | agy build → evidence → read-only reviewer → evidence card → `canMerge`. **First verified FounderOS task.** | laptop Claude |
| 5–7 | Reviewer eval set, post-deploy oracle, lean executor prompt; then Oplify | Claude, then agy through the new path |

The verifier is not built by the builder it verifies, so days 1–4 are laptop Claude work and carry no Antigravity
brief. From day 5 agy takes tasks through the new path.

## 7. Founder decisions (2026-10-05)

1. Spec card on every task until 3 verified merges, then low-risk specs auto-approve (v2 rule).
2. Thin slice first, not the full 16-day build.
3. Pass P runs as `claude-agent` (no sudo, no `.env`, no GitHub credential).
4. pr-brain back on now with the current prompt, limited to `task/*` PRs, until the read-only version lands.
5. Composio is removed: prod uses `GMAIL_BACKEND=gws`, `CALENDAR_BACKEND=gws`, `LINKEDIN_BACKEND=direct`; Composio
   is only a boot-time "legacy fallback". Removal ships as its own Full-depth PR (it touches send/post providers),
   then the `COMPOSIO_*` lines leave `/opt/founderos/.env` and the key is revoked.

## 8. NOT VERIFIED

- Turn latency is from the 10-04 UX audit; `psql` is not on the VPS host, so it was not re-measured.
- pr-brain's catch rate: #861 is one miss, not a measured rate. No planted-defect run yet.
- Whether Oplify's CI can carry `verifySpecRed` / `verifyImplementationGreen`: its workflows were not checked.
- Estimates are estimates; v2's own total was 16 days.
- Dispatch counts come from `agent-dispatch.log`, not cross-checked PR by PR on GitHub.

## 9. Founder actions

1. Create the fine-grained GitHub token (Contents, Pull requests, Issues; founderos + Oplify repos) and install it
   on the VPS for the orchestrator; revoke the all-scope token once the replacement works.
2. `/login` once as `claude-agent` on the VPS.
3. Turn pr-brain back on (`/review` in Telegram).
4. After the Composio removal PR is deployed, revoke the Composio API key in the Composio dashboard.
