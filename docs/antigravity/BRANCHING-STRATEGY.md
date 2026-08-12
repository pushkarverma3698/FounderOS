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
| `chore/<slug>` | Claude or founder, non-behavioral (docs, deps, cleanup) | fresh `origin/main` | until merged |
| `docs/<slug>` | Claude or founder, documentation only | fresh `origin/main` | until merged |
| Human-authored Antigravity briefs (`AG-NNN`) | whatever branch name the dispatching session picks — see `README.md` | fresh `origin/main` | until merged |

`main` and `beta` are never committed to directly by anyone or anything. That rule already existed
in `CLAUDE.md`'s Git section — this doc is the "how," not a replacement for it.

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
