# Branch Model — beta / main

FounderOS uses a **two-stage promotion** — `feat/* → beta → main` — so production
(`main`) stays protected while agents integrate continuously on `beta`. Claude may merge
the `beta → main` promotion once both required CI checks are green (CD auto-deploys).

> **Note:** an earlier `stable` tier (`beta → stable → main`) was **retired** — it
> added a promotion hop with no protection value once branch protection landed on
> `main`. The ladder is now two-stage. Branch protection on `main` enforces exactly
> this; any doc that still says `beta → stable → main` is stale. See ADR-045.

```
main    ─────────────────────────────●────────▶  production (CD deploys on merge)
                                      │
beta    ───────●────●────●──────────▶           integration (CI gate, agents merge here)
                ╲   ╱ ╲   ╱
feat/*           ●─●   ●─●                       short-lived, cut from beta
```

## Branches

| Branch | Purpose | Who merges | Deploys |
|--------|---------|------------|---------|
| **`main`** | Production truth | Anyone, via a green `beta → main` PR (branch protection still requires both CI checks) | Hetzner VPS via CD |
| **`beta`** | Active integration | Agents + founder via PR | Never deploys |
| **`feat/*`** `fix/*` `chore/*` + any agent branch (`cursor/*`, `claude/*`, …) | One task per branch | PR → `beta` | Never |

## Rules (non-negotiable)

1. **Never commit directly to `main`.**
2. **Cut feature branches from `beta`**, not from `main`.
   ```bash
   git fetch origin
   git checkout beta && git pull origin beta
   git checkout -b feat/my-feature
   ```
3. **Open PRs to `beta`** — CI must pass. Any work/agent
   branch may target `beta`; the policy rejects only `main` as a beta PR head.
4. **Promotion**: when `beta` is green, build `chore/promote-<slug>` from `origin/main` plus
   `git merge origin/beta`, open a PR to `main`, and merge it with `gh pr merge --merge` (never
   `--squash`: squash strands the `main → beta` sync) once CI is green → CD deploys.
5. **Claude may merge the promotion; implementers do not.** Antigravity, Codex and Gemini open
   draft PRs to `beta` only.

## Per-feature workflow

```bash
git checkout beta && git pull origin beta
git checkout -b feat/office-tier1
# … work …
pnpm gate
git push -u origin feat/office-tier1
gh pr create --base beta --title "feat: …" --draft
```

After merge to `beta`, test on the VPS **without** deploying (beta is not deployed).
When satisfied:

```bash
git fetch origin && git checkout -B chore/promote-<slug> origin/main && git merge origin/beta
# push the branch, then:
gh pr create --base main --title "chore: promote <slug>"
gh pr merge --merge    # on green CI, never --squash → GitHub Actions deploys
```

## Branch protection (configured on GitHub)

| Branch | Protection |
|--------|------------|
| `main` | Required CI check **`gate`** only, CODEOWNER review, no force-push |
| `beta` | Required CI check **`gate`**, PR required, no force-push |

After a `beta → main` merge, `.github/workflows/sync-beta.yml` fast-forwards
`beta` to `main` so the next promotion PR is never "commits behind".

## Cleanup

Delete merged remote branches (keeps `main`, `beta`):

```bash
./scripts/prune-merged-branches.sh --dry-run
./scripts/prune-merged-branches.sh
```

## Hotfix (production broken)

1. Cut `fix/hotfix-description` from **`beta`** (or `main` if beta is ahead and broken).
2. PR → `beta`, verify.
3. Fast-track: `beta` → `main` with founder approval.

## Related

- CD: `.github/workflows/deploy.yml` (triggers on `main` only)
- CI: `.github/workflows/ci.yml`
- Enforcement: branch protection on `main` (required status checks). The
  `branch-policy.yml` workflow was deleted on 2026-08-01 — see the note below.

---

## 2026-08-01 — the promotion gate was removed

`.github/workflows/branch-policy.yml` is deleted, and merging `beta → main` is no
longer founder-only. Founder directive, and the reason is a measured one rather
than a preference.

**What went wrong.** On 2026-08-01 production was running `a966e9a` — code that
sent no job brief at all — while the fix had been green on `beta` for hours and
three further PRs had stacked behind it. The founder's report ("the entire
pipeline is stale") described a deployment gap, not a code defect. The gate meant
to protect production was the thing keeping production broken.

**What replaces it.** Nothing ceremonial. The real protections are unchanged and
they are the ones that were ever load-bearing:

- Branch protection on `main` still requires both CI checks to pass.
- `pnpm gate` still runs lint, build, wiring, architecture fitness and the full
  test suite before anything is pushed.
- CD still refuses to restart the live service unless every deploy step passes,
  leaving the previous version running on failure.

**The obligation that comes with it.** Whoever merges to `main` owns the deploy:
watch the CD run, then confirm on the box that prod actually moved
(`ssh founderos-vps 'cd /opt/founderos && git log --oneline -1'`). A merge is not
a deploy. Prod sitting a day behind a green `main` is the exact failure this
change exists to stop, and it is equally possible in the other direction.
