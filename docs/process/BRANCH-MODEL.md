# Branch Model — stable / beta / main

FounderOS uses a **four-tier** model so production (`main`) never loses stability.
All feature work integrates on `beta` first; only the founder promotes to `stable`
and then to `main` (production auto-deploy).

```
main    ─────────────────────────────●────────▶  production (CD deploys on merge)
                                      │
stable  ────────────────────●─────────┘          release candidate (founder merges only)
                            │
beta    ───────●────●──────●──────────▶         integration (CI gate, agents merge here)
                ╲   ╱ ╲   ╱
feat/*           ●─●   ●─●                       short-lived, cut from stable
```

## Branches

| Branch | Purpose | Who merges | Deploys |
|--------|---------|------------|---------|
| **`main`** | Production truth | **Founder only** (CODEOWNERS + branch protection) | Hetzner VPS via CD |
| **`stable`** | Last validated release line | **Founder only** | Never deploys directly |
| **`beta`** | Active integration | Agents + founder via PR | Never deploys |
| **`feat/*`** `fix/*` `chore/*` + any agent branch (`cursor/*`, `claude/*`, …) | One task per branch | PR → `beta` | Never |

## Rules (non-negotiable)

1. **Never commit directly to `main` or `stable`.**
2. **Cut feature branches from `stable`**, not from `main` or `beta`.
   ```bash
   git fetch origin
   git checkout stable && git pull origin stable
   git checkout -b feat/my-feature
   ```
3. **Open PRs to `beta`** — CI + branch-policy workflow must pass. Any work/agent
   branch may target `beta`; the policy rejects only `main`/`stable` as a beta PR head
   (no prefix allowlist to keep in sync — a new agent tool's branches just work).
4. **Promotion ladder** (founder merges in GitHub UI):
   - When `beta` is green + live-verified → PR **`beta` → `stable`**
   - When ready for production → PR **`stable` → `main`** → CD deploys
5. **Agents never merge to `main` or `stable`.** Draft PRs to `beta` only.

## Per-feature workflow

```bash
git checkout stable && git pull origin stable
git checkout -b feat/office-tier1
# … work …
pnpm gate
git push -u origin feat/office-tier1
gh pr create --base beta --title "feat: …" --draft
```

After merge to `beta`, test on the VPS **without** deploying (beta is not deployed).
When satisfied:

```bash
gh pr create --base stable --head beta --title "release: promote beta to stable"
# founder merges → then:
gh pr create --base main --head stable --title "release: production deploy"
# founder merges → GitHub Actions deploys
```

## Branch protection (configured on GitHub)

| Branch | Protection |
|--------|------------|
| `main` | Required CI, CODEOWNER review, no force-push |
| `stable` | CODEOWNER review, no force-push |
| `beta` | Required CI, PR required, no force-push |

## Cleanup

Delete merged remote branches (keeps `main`, `stable`, `beta`):

```bash
./scripts/prune-merged-branches.sh --dry-run
./scripts/prune-merged-branches.sh
```

## Hotfix (production broken)

1. Cut `fix/hotfix-description` from **`stable`** (not `beta` if beta is ahead).
2. PR → `beta`, verify.
3. Fast-track: `beta` → `stable` → `main` with founder approval.

## Related

- CD: `.github/workflows/deploy.yml` (triggers on `main` only)
- CI: `.github/workflows/ci.yml`
- Enforcement: `.github/workflows/branch-policy.yml`
