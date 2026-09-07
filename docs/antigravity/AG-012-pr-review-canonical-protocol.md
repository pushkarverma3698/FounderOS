# AG-012 — Make `pnpm pr:review` invoke the canonical `pr-adversary` skill, not a stale copy

**Milestone:** cross-cutting (Brain/Doer tooling)
**Branch:** `fix/pr-review-canonical-protocol` — cut from fresh `origin/main`. PR base: `main`
(the last 7 merged FounderOS PRs all targeted `main` directly — `beta` has drifted stale;
verified 2026-09-07, see the session doc for that date).
**Status:** ready to dispatch
**Read [STANDARDS.md](STANDARDS.md) in full before writing any code. It is binding.**

---

## Goal

`scripts/claude-review-pr.ts` (`pnpm pr:review <N>`) is the repo's own built-in mechanism for
invoking headless Claude Code against a PR — and it embeds a stale copy of the review protocol
instead of the one Claude actually maintains. It reads
`docs/antigravity/CLAUDE_REVIEWER_INSTRUCTIONS.md` and splices its text directly into the
`claude -p` prompt. The two mechanisms that actually run today do something simpler and correct
instead: the `/pr-review` slash command (`~/.claude/commands/pr-review.md`, laptop-local, not part
of this repo) and the VPS sweep (`~/Projects/scripts/ai-tools/pr-brain`, also not part of this
repo) both tell Claude to **"invoke the pr-adversary skill and follow it exactly."** FounderOS's
own `CLAUDE.md` (§ "Brain / Doer Division") is explicit that the protocol lives in that skill and
should never be improvised. `scripts/claude-review-pr.ts` is the one caller left that still
improvises it — a second, drifting copy of a protocol Claude itself deprecated in favor of a single
skill file precisely so a fix in one place reaches every caller.

**Done means:** `pnpm pr:review <N>` constructs a prompt that invokes the `pr-adversary` skill by
name — the same instruction `/pr-review` and `pr-brain` already send — instead of reading and
embedding `CLAUDE_REVIEWER_INSTRUCTIONS.md`. The prompt-building logic is a pure, exported,
unit-tested function, not inline string concatenation inside `main()`.

---

## Measured starting state — verify these yourself before you begin

```bash
wc -l scripts/claude-review-pr.ts
grep -rl "claude-review-pr" tests/ || echo "no matches"
grep -n "CLAUDE_REVIEWER_INSTRUCTIONS\|readFileSync\|protocolPath" scripts/claude-review-pr.ts
```

| Measure | Value |
|---|---|
| `scripts/claude-review-pr.ts` length | 107 lines |
| Existing test coverage for this script | **0** — no file under `tests/` references `claude-review-pr` |
| What it currently embeds in the prompt | the full text of `docs/antigravity/CLAUDE_REVIEWER_INSTRUCTIONS.md`, read via `readFileSync` at runtime and spliced into `reviewPrompt` |
| What the two mechanisms that actually run do instead | quoted below |

`~/.claude/commands/pr-review.md` (laptop slash command, outside this repo):
> "**Invoke the `pr-adversary` skill now and follow it exactly.** It holds the full protocol:
> tree-stability check → read the claim → re-run the gate yourself → adversarial audit → reality
> check → verdict → report."

`~/Projects/scripts/ai-tools/pr-brain`'s `build_prompt()` (VPS sweep, outside this repo):
> "Invoke the pr-adversary skill and follow it exactly. An executor (Antigravity) wrote this PR;
> your default posture is disproof, not agreement. Green CI is a necessary condition, never the
> verdict."

Both are short, both name the skill directly, neither reads a second protocol file at runtime.
That is the pattern this brief asks you to match.

---

## Files in scope

| Path | Change |
|---|---|
| `scripts/claude-review-pr.ts` | Extract prompt construction into a pure, exported function (e.g. `buildReviewPrompt(prNumber: string): string`) that instructs Claude to invoke the `pr-adversary` skill and follow it exactly — matching the two quotes above. Remove the `readFileSync`/`existsSync`/`protocolPath` block that loads `CLAUDE_REVIEWER_INSTRUCTIONS.md` — it becomes dead code as a direct result of this change, not a separate cleanup. `findClaudeBinary`, `buildExecutorEnv`, the `spawn(...)` call, and the CLI's `<PR_NUMBER|all>` interface are unchanged. |
| `tests/unit/scripts/claude-review-pr.test.ts` (new) | Unit tests for `buildReviewPrompt`: one true positive (the prompt contains `pr-adversary` and the PR number), one true negative (the prompt does **not** contain the literal string `CLAUDE_REVIEWER_INSTRUCTIONS`). Fixtures only — STANDARDS §9. |
| `docs/antigravity/ISSUE-DRIVEN-CONTRACT.md` | One-line fix to its own header, which currently misattributes the protocol: it lists `CLAUDE_REVIEWER_INSTRUCTIONS.md` as *"the review side of this same loop, run by `pr-brain`"* — `pr-brain`'s own source (quoted above) invokes the `pr-adversary` skill, not that file. Point the sentence at `pr-adversary` instead; do not otherwise edit this document. |

---

## The pattern to follow

Match the shape of the two quotes above — short, names the skill, states the unattended-specific
constraints (finish with exactly one GitHub action, never force-push, never merge to
main/master) — not the multi-step "Execution Brief" `scripts/claude-review-pr.ts` currently writes
out by hand (checkout → diff → gate → audit → fix-or-approve). That entire sequence is what the
`pr-adversary` skill already encodes; restating it in the prompt is the same duplication this brief
exists to remove, just moved rather than fixed.

Keep the existing `all` mode, the `getCleanEnv()` stripping of `GH_TOKEN`/`GITHUB_TOKEN`, and the
`spawn(..., { stdio: "inherit" })` wiring exactly as they are — none of that is the defect.

---

## Explicitly forbidden

- Do not delete or rewrite `docs/antigravity/CLAUDE_REVIEWER_INSTRUCTIONS.md` itself. Whether that
  file should be retired entirely is a separate decision for Claude/the founder — out of scope
  here. This brief only stops one script from improvising off a stale copy of it.
- Do not change the CLI usage (`pnpm pr:review <PR_NUMBER|all>`) or add new flags.
- Do not touch `~/bin/pr-brain`, `~/Projects/scripts/ai-tools/pr-brain`,
  `~/.claude/commands/pr-review.md`, or anything under `~/.gemini/` — all outside this repo and
  outside this brief's scope.
- Do not add a new npm dependency.
- Do not touch unrelated `console.log`/`console.error` calls already in the file — they are not
  this brief's concern.

---

## Verify

Run and **paste raw output**:

```bash
pnpm lint && pnpm verify:arch && pnpm test
```

Then prove the claim rather than asserting it:

```bash
grep -n "pr-adversary" scripts/claude-review-pr.ts
grep -n "CLAUDE_REVIEWER_INSTRUCTIONS" scripts/claude-review-pr.ts   # expect: no output
```

The first grep must find the skill name in the constructed prompt; the second must return nothing.
Paste both results either way — a clean pass on the second is the pass condition for this brief.

State in the PR body whether you ran a live `claude -p` invocation to confirm the new prompt
actually triggers the skill, or unit tests only. **"NOT VERIFIED — reason" is acceptable** (this
machine's headless `claude -p` may not be authenticated — check `claude auth status --text` and
say what it reports rather than guessing). **A claim of live verification that did not happen is
not acceptable.**
