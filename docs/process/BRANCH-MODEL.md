# Branch Model

FounderOS uses a three-tier branch model to keep all development "in process" and
to keep production stable.

```
main   ──────────────────────────●──────────●────────▶   production (CD auto-deploys)
                                 ╱          ╱  (promote beta when stable)
beta   ●───────●───────●────────●──────────●─────────▶   long-lived integration
        ╲     ╱ ╲     ╱ ╲      ╱
feat/*   ●───●   ●───●   ●────●                            short-lived, one per phase
```

## Rules
1. **`main` = production.** CD auto-deploys on merge. NEVER commit directly to `main`;
   only `beta → main` promotions land here.
2. **`beta` = long-lived integration branch**, cut from `main`. All feature work merges
   here first via PR.
3. **`feat/*` = short-lived feature branches**, one per phase/feature, cut from `beta`,
   PR'd back into `beta`. Naming: `feat/hierarchy-<phase>-<short-desc>`.
4. **Promotion = production deploy.** When `beta` is stable (tests green, live-verified),
   open a PR `beta → main`; merging it deploys to production via the existing CD pipeline.

## Per-feature flow
1. `git checkout beta && git pull`
2. `git checkout -b feat/<name>`
3. Work + commit; `pnpm test` and `pnpm lint` must be green.
4. `gh pr create --base beta` → human merges.
5. When beta is stable → PR `beta → main`.
