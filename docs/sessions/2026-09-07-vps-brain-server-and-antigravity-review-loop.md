# 2026-09-07 — VPS brain server + Antigravity test-fix-review loop

## What we did

Picked up from two prior sessions' outstanding item — "no brain server runs on the VPS, every
IDE reads the laptop's Postgres" — and a founder ask to (1) finish that properly with all IDEs
repointed, evaluate whether `pr-brain` is still needed, and (2) formalize Antigravity owning the
full code→test→live-test→fix loop with Claude narrowed to a final, invokable review gate.

Dispatched two parallel background agents (isolated worktrees) with the architecture already
decided rather than left open:

1. **VPS brain unification** — repoint every IDE's brain MCP from a local-Postgres process to an
   SSH-exec'd process on `founderos-vps`, migrate any laptop-only data first, evaluate `pr-brain`
   with evidence before recommending keep/delete.
2. **Antigravity test-and-fix-live + request-claude-review skills** — investigate Antigravity's
   real command surface before building, respect the zero-paid-calls-in-dev-loop rule, and design
   the Claude-handoff mechanism against what's actually reachable from Antigravity's shell.

Every claim from both agents was independently re-verified against the live systems (VPS SSH,
Postgres row counts, `~/.claude.json`/Antigravity/Cursor config files, a real MCP JSON-RPC round
trip, `claude auth status` on both laptop and VPS) before being accepted — per this repo's
"review is mine and is not delegable" rule. Two real defects were found this way and fixed before
calling anything done (see below).

## What we fixed

- **Brain MCP repointed**, all IDEs: `~/Projects/scripts/ai-tools/founderos-brain-mcp.sh` now
  execs `src/mcp/turicks-brain.ts` **on the VPS** over the existing `founderos-vps` SSH key
  (mirrors the transport already proven in `deploy/mcp-founderos-vps.example.json` from #615) —
  no new port, no public Postgres, no new secret. Claude Code and Antigravity were confirmed
  already pointed at the wrapper (their `.bak-2026-09-06` files still show the dead
  `turicks-brain-rag/.venv/bin/fastmcp` path, confirming these were fixed in #617 and untouched
  now). **Cursor wired for the first time** (`~/.cursor/mcp.json`, previously nothing configured).
- **21 laptop-only `brain_memories` rows migrated** into the VPS table (from `docs/architecture.md`
  and `docs/sessions/2026-09-06-job-pipeline-audit.md`, never synced past the laptop) before the
  cutover. VPS: 1380 → 1401 rows, 0 conflicts, re-verified 0 laptop-only rows remain afterward.
  The laptop's own `turicks-postgres` container (not `founderos-postgres`, which turned out to be
  an empty red herring also running locally) is now an abandoned copy — left running, untouched.
- **Live-verified the new path myself**, not just on the agent's word: a raw JSON-RPC round trip
  through the rewritten wrapper script returned a real scored `search_memory` result, with
  `"env":"production"` in the server's own log line confirming it executed on the VPS. Round-trip
  cost: ~4.2s one-time connect (SSH handshake + remote cold boot, paid once per IDE session start),
  ~954ms steady-state per call (real Ollama embed + vector search, not overhead). Prod's bot
  (`founderos.service`) confirmed unaffected throughout — `ActiveEnterTimestamp` and `HEAD`
  (`c2aea78`) identical before and after.
- **[PR #622](https://github.com/pushkarverma3698/founderos/pull/622)** — `deploy.sh`'s post-deploy
  brain-health check was still querying `brain.turicks_brain`, the table #620 already established
  is frozen since ADR-038. It always read 0, silently masking the real store's health on every
  deploy since #620 landed. Fixed to query `brain.brain_memories`; live-verified against prod
  (returns 1401, matching the corrected count above). `pnpm gate`: 342 files / 3756 tests green.
- **Two new Antigravity global skills**, `~/.gemini/antigravity/global_skills/{test-and-fix-live,
  request-claude-review}/SKILL.md`. First runs the free `pnpm gate` loop unbounded, then the single
  paid live-verification pass this repo allows per change, capped at 2 attempts total (one-shot
  rule, never re-run a pass "to double check"). Second confirms a real pushed PR exists, then
  triggers Claude's review via a 3-tier runtime check (direct headless `claude -p` → VPS `pr-brain
  --pr <N>` → print the manual `/pr-review <N>` command), and reports the review's *actual* outcome
  read back from `gh pr view`, not a subprocess's own stdout claim.
- **Fixed a real defect found during my own verification, before shipping the skill**:
  `request-claude-review`'s Tier-2 courtesy check only tested `pr-brain.off`/lock presence, not
  whether the VPS's Claude session actually works. `claude auth status` on the VPS reports a
  valid-looking Claude Pro session (cached credential presence) while a real `claude -p` call
  independently returned `401 OAuth access token has expired` — the exact same root cause behind
  `pr-brain`'s own failure (see Metrics). As written, Tier 2 would have confidently fired a command
  that just appends another identical FATAL line. Patched both Tier 1 and Tier 2 to treat
  `claude auth status` as necessary, not sufficient, and to check `pr-brain`'s own log tail (which
  reflects a real prior invocation attempt) before relying on Tier 2.
- **Fixed a policy-drift defect**: both new skills and the AG-012 brief (below) hardcoded PR base
  `beta`, inherited from Antigravity's own pre-existing `doer-contract`. Checked the last 7 merged
  FounderOS PRs (#611, #613, #615, #617, #619, #620, #621) — all targeted `main` directly. `beta`
  has drifted stale (a 2026-09-05 session found it 21 commits behind `main`). Corrected all three
  to base `main`, matching actual practice; left the deeper inconsistency in `doer-contract` itself
  as a founder decision (out of scope — it's pre-existing Antigravity infrastructure neither agent
  was dispatched to touch).
- **[AG-012](../antigravity/AG-012-pr-review-canonical-protocol.md)** written (required — every plan
  ships an executable Antigravity brief in the same session): `scripts/claude-review-pr.ts`
  (`pnpm pr:review <N>`) is the one caller left that still embeds a stale copy of the review
  protocol (`docs/antigravity/CLAUDE_REVIEWER_INSTRUCTIONS.md`) instead of invoking the canonical
  `pr-adversary` skill by name, unlike `/pr-review` and `pr-brain`, which both already do it
  correctly. Not dispatched to Antigravity yet — that's the founder's call, not something either
  agent or this session was asked to trigger.
- **`docs/antigravity/README.md`'s brief index backfilled** — silently stopped at AG-007, missing
  AG-008 through AG-011 (all merged & shipped to prod on 2026-08-20 per
  `observability-eval-batch-2026-08-19.md`) and now AG-012.

## Why

Two prior sessions (2026-09-05, 2026-09-06) recorded the brain's split-store problem as fixed but
explicitly flagged "no brain server runs on the VPS" and "dies whenever laptop Docker is down" as
still open. The founder's own directive: "one brain is to be properly implemented and live tested
... always use your reasoning" on whether `pr-brain` is still needed. Reasoned conclusion:
`pr-brain`'s value is unattended coverage (catching PRs that finish while nobody's watching); an
on-demand Antigravity-invoked review command only helps when the founder remembers to trigger it —
these are complementary, not redundant, so `pr-brain` was not deleted. It turned out to be broken
anyway (see Metrics), for a reason unrelated to whether it's still wanted.

## Metrics

- **`pr-brain`: confirmed BROKEN**, independently verified via its own log — `FATAL: Claude Code
  cannot authenticate` logged every 20 minutes, continuously, from at least 2026-09-06T20:20Z
  through 2026-09-07T09:40Z+ (40+ consecutive failed cron ticks, still failing at last check).
  Root cause: the VPS's Claude Pro OAuth token has expired (confirmed via a real `claude -p` call
  returning `401`, not just the cached `claude auth status` check, which misleadingly still shows
  "logged in"). Crontab active, kill switch absent — not a deliberate pause. This is the same root
  cause that would have silently defeated the new skill's Tier 2 before the fix above.
- Brain data: VPS `brain.brain_memories` 1380 → 1401 rows (post-migration). Round trip: ~4.2s
  connect / ~954ms per call, independently re-measured.
- `pnpm gate` on PR #622: 342 test files / 3756 tests, 0 failures.
- 8 additional live (non-test) call sites still query the frozen `brain.turicks_brain` table
  (found, not fixed — bigger than one-liners): `scripts/ingest-external-chats.ts` (highest
  severity — silently writes/deletes against a table nothing reads, i.e. live data loss),
  `scripts/run-retrieval-eval.ts`, `src/eval/retrieval-runner.ts`, `src/eval/retrieval-golden.ts`,
  and four VPS diagnostic/QA scripts (`vps-prod-hardcore-qa.sh`, `vps-prod-stabilize.sh`,
  `prod-log-diagnose.sh`, `vps-marketing-launch-gate.sh`).

## Outstanding

1. **VPS Claude Pro re-authentication** — the single blocker behind both `pr-brain` and the new
   skill's Tier 2. `ssh founderos-vps`, then interactively `claude` → `/login` as the `founderos`
   user. This is a real OAuth/browser flow; only the founder can do it.
2. **AG-012 not dispatched.** Command is in the brief
   (`docs/antigravity/AG-012-pr-review-canonical-protocol.md`) — deliberately not run
   autonomously, since it's a finding this session surfaced, not something asked for.
3. **Neither new Antigravity skill has been exercised through a real Antigravity conversation.**
   First real invocation is the real test — not simulated here to avoid triggering a real VPS
   review run or creating conversation state unprompted.
4. **8 files still querying the frozen `brain.turicks_brain` table** (listed above) — a founder
   call on scope/priority. `scripts/ingest-external-chats.ts` is the one with active, silent data
   loss and probably shouldn't wait.
5. **`docs/guides/DEPLOYMENT.md:117-127`** describes a migration procedure against the deleted
   `~/Projects/turicks-brain-rag` Chroma path — stale, not rewritten here.
6. **Laptop's abandoned `turicks-postgres` container** still running, now unused by anything.
   Left alone; disk-reclaim is the founder's call.
7. **One open background-task chip**: `task_c2dda1f0` — `scripts/deploy-mcp-to-vps.sh` and
   `scripts/check-mcp-status.sh` hardcode `root@` VPS login, which prod now denies entirely.
8. **`pnpm brain:sync` needs to run after this PR merges** (docs/ changed) — cannot run from any
   worktree (needs a real `.env` file + `node_modules`); run from a proper checkout post-merge.
