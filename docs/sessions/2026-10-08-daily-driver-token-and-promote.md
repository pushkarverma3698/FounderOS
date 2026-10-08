# 2026-10-08 — one token, one repo list, /promote from Telegram

## What we did
- Landed on beta: #1011 (AG-039, one bot token for every daemon), #1008 (install/deploy `APP_DIR`, founder seed skip), #1009 (AG-041, `/promote`).
- Promoted to main as #1019 (`d3fb5304`, merge commit). Deploy green; prod HEAD `d3fb5304`, `founderos` active, `promote-run` installed in `~founderos/bin`.
- Live checks on prod, through the real path:
  - `agent-dispatch --list` as `founderos`: lists all five repos, exit 0.
  - `/promote` via `scripts/telegram-probe.ts`: "Nothing to promote: main already has every change on beta (beta 00b1930)", first reply in 3s.
  - `/task repo:fos-journey-sandbox …` via the probe, card approved with `telegram-tester.ts approve`: issue #5 filed, `fos-job` claimed it, the AG-039 token loaded and the repo sweep ran.

## What we fixed
- #1009 had a gap after #1011: `promote-run` got no token or git credential helper. `job-run` now loads the token before the promote stage; two tests cover it (they failed before the fix).
- `.env.example` documents the new `DISPATCH_REPOS_*` and `PROMOTE_RUN_*` variables (`env-example-complete` enforces it).

## Why
Laptop-free loop: `/task` → spec → build → review → card → merge → `/promote` → deploy, driven from Telegram with one owner per job.

## Metrics
- /promote reply 3s; /task card 14s.
- Spec stage on issue #5: rejected in 6s, `claude-agent` weekly limit (resets 2026-10-11 00:00 UTC).

## Outstanding
- NOT VERIFIED: the build and review stages after AG-039 (blocked by the quota above); a `/promote` that carries a real change (push and merge to main with the bot token). First candidate: this docs PR.
- Sonnet reviewer quota out until about 10-10/10-11; `claude-agent` spec quota out until 10-11.
- Founder: Google OAuth re-auth; AG-038 and A/B decision (#1010); `unfreeze` label for #1007; group-chat call on #1006; Google AI Studio credit.
