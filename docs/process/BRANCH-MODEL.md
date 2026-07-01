# Branch Model — flat: work branch → main → deploy

**Simplified 2026-07-01.** FounderOS previously used a four-tier `feat/* → beta →
stable → main` promotion ladder. It was removed: it required three PRs to ship one
change and did not buy any safety that CI + branch protection don't already provide.

The model is now flat:

```
work branch (feat/*, fix/*, chore/*, claude/*, cursor/*, …)
        │  PR + green CI
        ▼
main  ───────────────────────────▶  production (CD auto-deploys on merge)
```

## Branches

| Branch | Purpose | Deploys |
|--------|---------|---------|
| **`main`** | Production truth. All work merges here via PR once CI is green. | Hetzner VPS via CD on every merge |
| **`feat/*` `fix/*` `chore/*` + any agent branch (`cursor/*`, `claude/*`, …)** | One task per branch, cut from `main`. | Never (until merged) |

> `beta` and `stable` are retired as gates. They may still exist as branches, but
> nothing enforces a ladder through them and nothing deploys from them.

## Rules

1. **Never commit directly to `main`.** Always branch, PR, merge.
2. **Cut branches from `main`:**
   ```bash
   git fetch origin
   git checkout main && git pull origin main
   git checkout -b feat/my-feature
   ```
3. **Open the PR straight to `main`.** CI must be green (`pnpm gate`). Any branch may
   target `main` — the old `branch-policy` ladder check is now a no-op pass.
4. **CD deploys on merge to `main`** (`.github/workflows/deploy.yml`): merge → CI runs →
   on success, deploy fires to the VPS. There is no separate promotion step.

## Per-feature workflow

```bash
git checkout main && git pull origin main
git checkout -b feat/office-tier1
# … work …
pnpm gate                       # tsc + tests, $0
git push -u origin feat/office-tier1
gh pr create --base main --title "feat: …" --draft
# green CI + review → merge → CD deploys
```

## Branch protection (configured on GitHub)

| Branch | Protection |
|--------|------------|
| `main` | Required CI (tests + tsc/lint), no force-push. Add CODEOWNER review if desired. |

> If `Verify PR base/head branches` is still listed as a **required** status check,
> it now always passes (no-op). Remove it from Settings → Branches once convenient,
> then delete `.github/workflows/branch-policy.yml`.

## Cleanup

Delete merged remote branches (keeps `main`):

```bash
./scripts/prune-merged-branches.sh --dry-run
./scripts/prune-merged-branches.sh
```
