# 2026-09-05 — every open branch audited and landed on main

## What we did

Fourteen remote branches, four open PRs. Audited each against `origin/main`,
merged the live work onto one integration branch
(`claude/chore-prod-integration-audit`), and closed the rest.

**Ten branches were already fully merged** — `ahead=0`, empty diff against main:
`claude/job-hunt-pipeline-progress-07ec4b`, `claude/multi-profile-jobhunt-audit-facd55`,
`claude/job-pipeline-lead-audit-b8fcff`, `claude/vertex-ai-migration-audit-1a819b`,
`fix/eval-harness-recursion-and-hitl`, `fix/jobhunt-cv-claim-guard`,
`chore/vertex-migration`, `fix/model-alias-fallback-chain`,
`claude/sweet-pike-6b0c3c`, `claude/wonderful-spence-d76aa2`. Deleted, not merged —
there was nothing in them.

**Three carried real work:**

| Branch | PR | Disposition |
|---|---|---|
| `cursor/feat-unified-postgres-brain` | #614 | merged (fast-forward), one blocker fixed |
| `feat/fix-telegram-commands` | #612 | **cherry-picked `a851019` only** |
| `cursor/audit-omnirouter-opencode` | #610 | merged, one fix applied, one debt flagged |

`feat/fix-telegram-commands` was branched off `beta`, so it carried `#606` and
`#608` — the two commits `beta` is ahead of `main` by. Those were re-applied to
main as `#611` with different content, so merging the branch would have reverted
main's CLAUDE.md/AGENTS.md/BRANCHING-STRATEGY.md to the older text. Only its one
unique commit was taken.

`beta` is 23 behind / 2 ahead of main and PR #601 (`main → beta`) conflicts for
the same reason. Handled by resetting `beta` to main, not by merging.

## What we fixed

**1. The brain wrote to a table nothing read. (BLOCKER)**

ADR-038 moved `pnpm brain:sync` off `brain.turicks_brain` onto
`brain.brain_memories`. Every reader was left behind: `search_knowledge`,
`search_turicks_brain`, `inspectRagHealth`, `getTuricksBrainCount`, and
`searchBrain`'s own default. `searchBrain` — the ADR's "one retrieval
implementation" — had zero production callers; only the new MCP server and a
demo script used it.

Shipped as-is: every doc synced from that day forward is invisible to the agent,
retrieval keeps answering from a table that can never be refreshed, and the
health check reports a healthy store counting rows no search can return. Nothing
errors. This is the 2026-08-07 shadow-table failure repeating — an empty
`agents.turicks_brain` shadowed the real one and vector search returned zero rows
for weeks.

It survived all 3,726 tests because the unit suite mocks the database, and no
test asserted the writer and the readers agree on a name.

**The dev database showed the split already live**: `brain.turicks_brain` held
**4,018** embedded chunks, `brain.brain_memories` held **1,308**. Two brains,
same box, same day.

And it was a three-way split, not two. Two more writers — `pnpm ingest:claude`
(`scripts/ingest-claude-sessions.ts`) and `pnpm session:sync`
(`scripts/sync-conversation-session.ts`) — were never mentioned in ADR-038 and
still targeted `turicks_brain`. They own **2,642 of the 4,018 rows, 66% of the
corpus**: the Claude and Antigravity session transcripts. Repointing readers
without them would have made the entire conversation memory invisible instead of
fixing anything, and their metadata uses different keys (`source`/`doc_type`, not
`source_path`/`entry_type`), so a backfill written against the doc shape alone
would have landed all 2,642 with a NULL source.

- All three writers now target `brain_memories`.
- All five readers now name `brain_memories`.
- `drizzle/0038_brain_backfill.sql` carries the corpus across, coalescing both
  metadata shapes, idempotent on the chunk's own sha256 (matching `contentSha()`,
  so the sync's skip-re-embedding path keeps working), and adds the **HNSW index
  0037 omitted** — `turicks_brain` has had one since `0005_pgvector`; without it
  every semantic search over the new table is a sequential scan.
- `tests/unit/db/brain-store-parity.test.ts` pins write ⇄ read parity as a
  source-text contract, because a mocked DB cannot see a table name. Verified RED
  against the pre-fix readers (3 failures), GREEN after.

**Migration proven against real data**, on a schema-isolated copy of the dev
database (no superuser, so `CREATE DATABASE … TEMPLATE` was unavailable; the
tables were cloned into a `migtest` schema and dropped afterwards):

| check | result |
|---|---|
| rows carried | 1,308 → **4,608** (+3,300; 718 already present by content sha) |
| second run | **`INSERT 0`** — idempotent |
| rows with NULL source | **0** |
| Claude / Antigravity transcripts carried | 2,267 / 164 |
| rows missing an embedding | 0 |
| planner on a k-NN query | `Index Scan using …_bm_embedding_idx` |
| top-3 neighbours of an ADR chunk | 1.000 / 0.802 / 0.798, all ADRs |

**2. `/commands` sent 19 Telegram messages.** One per command pair, one per
system command, plus two bare section headings — 2,258 characters across 19
sends, four of them under 60 characters, when the whole thing fits in one
4,096-character message. `handleCommands` awaits them in a tight loop and this
bot registers no throttler and no auto-retry, so that burst is the shape Telegram
answers with 429. Now three sections; his command and its `wife_` counterpart sit
together instead of split apart.

**3. `runPipelineDigest` went silent.** Per-profile digests were introduced with a
`rows.length > 0` skip, so an all-empty pipeline sent nothing at all — which from
Telegram is indistinguishable from a crashed cron. It now speaks once.

**4. `omnirouter:` hardcoded `127.0.0.1:20128`.** OmniRouter is laptop-only and
nothing listens on that port on the VPS. Now `OMNIROUTER_BASE_URL` /
`OMNIROUTER_API_KEY` with the same default. `DEFAULT_AGENT_MODEL` was confirmed
still `openrouter:google/gemini-flash-latest`, not omnirouter.

**5. `candidateName` unescaped** in both `pipeline-followup` renderers, while
`sweep-heartbeat` escaped it. Static config today, so no live defect; made
consistent.

## Why

Both handoff documents on the brain branch reported "100% VERIFIED & GREEN" and
"No BLOCKERs remain", and the gate genuinely was green — 340 files, 3,726 tests,
`pnpm gate` exit 0, reproduced here. Green CI was true and the verdict was still
wrong, because the defect lived in the one place the suite cannot see: agreement
between a script's SQL and a tool's SQL, with a mock in between.

The handoffs also misdescribed their own diff. Both claimed the `permit-routes.ts`
change was to `UNCLEAR_BASES`; the actual change rewrote `basesForPosting`'s
filter, which reorders the permit bases (`["zoekjaar", "hsm"]` instead of
`["hsm", "zoekjaar"]` for the wife). Same set, different priority — defensible,
and it matches the profile's own stated intent, but undocumented. Neither
handoff mentioned `criteria.ts`, `filters.ts` or `screen.ts` at all, which is
where the IND **reduced salary criterion** was introduced: a legal floor 28%
below the standard one, deciding which of his wife's applications are lawful to
send. €3,122 was re-verified against ind.nl and is correct; it had arrived with
no source, under a comment asserting verification.

## Metrics

| | |
|---|---|
| `pnpm gate` on the integration head | **exit 0** — 344 files · 3,747 tests |
| Tests added | 21 (7 brain parity, 3 command-menu, 1 digest silence, rest existing) |
| Branches before / after | 14 / 2 (`main`, `beta`) |
| Open PRs before / after | 4 / 0 |
| Blockers found after a "no BLOCKERs remain" handoff | 1 |
| Migrations added | `0038_brain_backfill.sql` |

## Outstanding

1. **`src/tools/opencode.ts` is a fork, not a module.** 372 lines against
   `claude-code.ts`'s 372, sharing 194 identical non-trivial lines. Its
   `openCodeTool` export is registered nowhere; only `findOpenCodeBinary` and
   `buildExecutorEnv` are consumed, by `scripts/opencode-review-pr.ts`. No gate
   catches an unregistered `UnifiedTool` — candidate fitness rule. Nothing in it
   runs in prod, so this is debt, not a defect.
2. **The IDE brain MCP is dead.** ADR-038 deleted
   `~/Projects/turicks-brain-rag` and `scripts/migrate-chroma-to-pgvector.ts`,
   but no IDE config was repointed: Claude Code still spawns the removed
   `.venv/bin/fastmcp` and fails with ENOENT at every session start. The
   replacement (`pnpm mcp:brain` → `src/mcp/turicks-brain.ts`) exists and is
   unconfigured. Founder action — see the handoff list.
3. **`scripts/eval-brain.ts` does not measure recall.** It prints hits. The
   handoff described it as measuring "Recall@1,3,5 against the benchmark"; there
   is no ground truth and no recall computation in it, and it is wired to no
   package.json script.
4. **`deploy-mcp-to-vps.sh` now installs `opencode-ai` globally on the VPS** for a
   review path that needs OmniRouter, which is laptop-only. Guarded by `|| true`,
   so it cannot fail a deploy.
5. **`omni_router/` is a new top-level directory** of 454 lines of research docs,
   outside the `docs/` convention.
