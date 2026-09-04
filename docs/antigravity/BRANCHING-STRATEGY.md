# Branching strategy — BINDING

**One branch per unit of work. Always. No exceptions for "it's small" or "I'll clean it up
after."** This applies to the automated dispatcher, to Antigravity's laptop-side briefs, and to
Claude's own work in this repo — the same discipline, everywhere, not one rule for agents and
another for humans.

**Why this exists:** by 2026-08-11 this repo's working tree had accumulated uncommitted, unrelated
changes from three different pieces of work sitting on `main` at once (a live Antigravity
laptop conversation editing `mac-client/` + jobhunt files, plus two untracked `docs/decisions/`
files from yet another session) — none of it conflicting, but all of it invisible to `git status`
as belonging to anything in particular. That's not a git problem, it's a branching-discipline
problem: none of that work had a branch of its own, so there was nothing to separate it from
whatever came next. A real engineering team doesn't let this happen — every task gets its own
branch before the first edit, not after.

## Branch types

| Prefix | Owner | Created from | Lifetime |
|---|---|---|---|
| `task/issue-<N>-<slug>` | `agent-dispatch` (VPS, unattended) | fresh `origin/main`, every claim | until the PR merges or the issue reaches `agent:blocked` |
| `feat/<slug>` | Claude or founder, new capability | fresh `origin/main` (or `beta` if stacking on unmerged infra) | until merged |
| `fix/<slug>` | Claude or founder, bug fix | fresh `origin/main` | until merged |
| `hotfix/<slug>` | Claude or founder, prod is broken *right now* | fresh `origin/main` | until merged (hours, not days) |
| `chore/<slug>` | Claude or founder, non-behavioral (deps, cleanup) | fresh `origin/main` | until merged |
| `docs/<slug>` | Claude or founder, documentation only | fresh `origin/main` | until merged |
| `refactor/<slug>` | Claude or founder, behavior-preserving restructure | fresh `origin/main` | until merged |
| `test/<slug>` | Claude or founder, tests only | fresh `origin/main` | until merged |
| `claude/<type>-<slug>` | a Claude Code session (harness cuts the branch) | fresh `origin/main` | until the PR merges — **then deleted** |
| `cursor/<type>-<slug>` | a Cursor session | fresh `origin/main` | until the PR merges — **then deleted** |
| `antigravity/<type>-<slug>` | an Antigravity laptop conversation | fresh `origin/main` | until the PR merges — **then deleted** |
| Human-authored Antigravity briefs (`AG-NNN`) | the dispatching session picks an `antigravity/<type>-<slug>` name — see `README.md` | fresh `origin/main` | until merged |

`main` and `beta` are never committed to directly by anyone or anything. That rule already existed
in `CLAUDE.md`'s Git section — this doc is the "how," not a replacement for it.

The three agent prefixes are **task-specific and short-lived**: a `claude/*`, `cursor/*` or
`antigravity/*` branch is fine while its PR is open and must not outlive it. There are no permanent
agent branches.

## Naming grammar — BINDING

```
<type>/<slug>                 humans, and any agent that can choose its own branch name
<agent>/<type>-<slug>         when the harness insists on owning the prefix
task/issue-<N>-<slug>         the VPS dispatcher only
```

- `<type>` ∈ `feat` · `fix` · `hotfix` · `chore` · `docs` · `refactor` · `test` — the same verbs as
  the commit convention, so a branch name and its commits agree.
- `<agent>` ∈ `claude` · `cursor` · `antigravity`.
- `<slug>` is lowercase kebab-case, **2–5 words that name the subject of the work**, `[a-z0-9-]`
  only. A trailing harness-generated hash (`-ac9712`) is allowed and ignored.
- Whole name ≤ 60 characters. No dates, no author names, no `-v2` / `-new` / `-final`, no `WIP`.

**A branch name is read by a human deciding whether to open the PR.** It must answer "what is in
here?" without opening it. `fix/jobhunt-cv-claim-guard` does. `claude/sweet-pike-6b0c3c` does not.

### The banned shape: harness codenames

Claude Code and Cursor will invent a random two-word codename when you do not give them one. This
repo has already merged **five** of them — `claude/sweet-pike-6b0c3c`,
`claude/wonderful-spence-d76aa2`, `claude/sad-burnell-86737c`, `claude/funny-fermat-552ryl`,
`claude/portfolio-ai-audit-kjik0f` — and the git history of a codename branch is unsearchable
afterwards: nothing in `sweet-pike` recalls what shipped in it.

**If the harness handed you a codename, rename it before the first push:**

```bash
git branch -m claude/fix-jobhunt-cv-claim-guard
```

Do it before the push, not after — renaming a pushed branch orphans the remote ref and any PR
already opened against it.

### Examples

| ✅ | ❌ | why the bad one fails |
|---|---|---|
| `fix/jobhunt-cv-claim-guard` | `fix/bug` | slug names nothing |
| `feat/rag-pipeline-upgrade` | `claude/wonderful-spence-d76aa2` | harness codename |
| `claude/docs-branch-naming-rules` | `claude/branch-naming-audit-ac9712` | missing `<type>-` after the agent prefix |
| `chore/prune-merged-branches` | `chore/cleanup-2026-09-05` | dates belong in git, not the name |
| `task/issue-412-cost-attribution` | `Feat/Cost_Attribution` | uppercase + underscores |

**Enforced by:** `scripts/verify-branch-name.sh`, run as part of `pnpm gate` (per rule #27 — a
rule with no mechanism decays). It is a no-op on `main`, `beta`, and detached CI checkouts, so it
only ever fires on a work branch you are about to push.

## Where a branch merges to

Naming a branch correctly is half the discipline; the other half is knowing what it targets. The
ladder is `work → beta → main`, because `beta` is where CD proves a change before prod sees it.

| Situation | PR base | Why |
|---|---|---|
| Normal work — features, fixes, chores, docs | `beta` | The ladder. CD exercises it on `beta` before prod. |
| `beta` → `main` promotion | `main` | Opened by hand when `beta` is green and ready to ship. |
| **Prod is broken now, or the deploy pipeline itself is broken** | `main` | Going through `beta` costs a full extra cycle while prod stays broken. Say *why* in the PR body. |

**The hotfix exception is narrow and must be justified in writing.** "I'd like this out sooner" is
not a hotfix. "Prod is currently serving stale code and this is the fix for the mechanism that
causes it" is — that is exactly PR #455 on 2026-08-12, where the deploy script's own ordering bug
meant *no* merge could reach prod at all, so routing its fix through `beta` would have delayed the
repair of the thing that ships every other repair.

**After anything lands on `main`, `beta` must be brought back up.** `.github/workflows/sync-beta.yml`
opens that sync PR automatically on every push to `main` — but it only *opens* it. Someone still has
to merge it, and until they do, every subsequent promotion PR is blocked and every branch cut from
`beta` starts out stale. Left alone once before, `beta` silently froze **125 commits** behind `main`
and the ladder stopped running entirely. Merging the sync PR is part of finishing the work, not a
separate chore.

**Never merge on red.** Branch protection requires both CI checks on `main`; a red or still-pending
check is a stop, not a speed bump — including on a sync PR.

## Rules

1. **Branch before the first edit, not after.** If you're mid-edit and realize there's no branch
   for it, stop and create one before going further — don't let uncommitted work accumulate on
   `main` "for now."
2. **One branch, one concern.** A branch that mixes an unrelated doc fix with a feature is a branch
   that produces a PR nobody can review cleanly. Split it, even if both changes are small.
3. **Never resurrect a stale branch for new, unrelated work.** Cut a fresh one from an up-to-date
   base every time — an old branch carries drift you didn't sign up to review.
4. **Short-lived.** A branch that's been open more than a few days without movement is either
   abandoned (delete it) or blocked (say why, on the PR). `scripts/prune-merged-branches.sh`
   already exists for the mechanical half of this — run it periodically.
5. **Delete on merge.** `gh pr merge --delete-branch`, not a manual follow-up someone forgets.
6. **Before creating a branch or switching one, check whether Antigravity is live on this
   checkout** (`~/Projects/scripts/ai-tools/agy-guard`). A branch switch is non-destructive to
   uncommitted work (git carries it forward), but never `git add -A`, `git stash`, or anything
   broad while `agy-guard` reports BUSY — stage only the files your own task touched, by name.
7. **The dispatcher already does 1–5 mechanically** for issue-driven work (`git checkout -B
   task/issue-<N>-<slug> origin/main`, fresh every claim, per
   `docs/antigravity/ISSUE-DRIVEN-CONTRACT.md`). This doc extends the same discipline to
   everything that isn't dispatcher-driven, so the whole repo works one way, not two.

## What this doc does not change

No new branch protection, no new CI gate — those are GitHub-security-adjacent settings and stay
out of scope here. This is a convention, enforced by discipline (and by `agent-dispatch`'s own code
for the automated half), the same way `CLAUDE.md`'s existing "never commit to main" rule already is.
