# 2026-10-10 — jobs-only standalone process (OpenDots migration, Phase 3)

## What we did
- Built `src/jobs/main.ts`, the new and only entry. It holds the single-instance lock, starts `/health` on 3001, then the jobs bot (`src/jobs/bot.ts`: job commands, their wife_ aliases, the jh: buttons) and the jobs crons (`src/jobs/scheduler.ts`: free sweep + daily brief, follow-ups, Monday digest, funding grower, monthly reminder, findings).
- Broke the hub imports that pulled the kernel into the jobs closure. `/draft` no longer falls back to a kernel turn, `/ask` is gone, and the findings check reports to Telegram without filing GitHub issues.
- Deleted everything outside the closure: kernel, planner, goals, eval, proof, agents, coding pipeline, JARVIS apps and their tests/scripts. Went from 592 to 227 `.ts` files under `src/`.
- `founderos.service` runs `pnpm start`, which is `dist/src/jobs/main.js`. The bot token is `JOBS_BOT_TOKEN`, falling back to `TELEGRAM_BOT_TOKEN`; the source used is logged at boot.

## What we fixed
- `verify-wiring` now checks that the ☰ menu matches the registered handlers and that every cron expression is valid. The old check was for the tool registry.
- `verify-architecture`: new tombstones for the kernel paths, and R2 (kernel purity) retired. Package-script entrypoints count as roots, so `src/jobs` is not an orphan.
- The deploy workflow lost the daemon-sync and oracle steps. `brain-sync.yml` lost the retrieval eval.

## Why
Founder decision 2026-10-10: retire everything except the job pipeline (`docs/plans/2026-10-10-opendots-migration.md`). The safety net is tag `archive/founderos-v3` (a7a0788e).

## Metrics
- `pnpm gate`: exit 0, 245 test files, 3304 tests.
- Local boot of `dist/src/jobs/main.js`: `/health` answered, 6 crons scheduled, SIGTERM gave a clean stop.

## Outstanding
- Founder creates the jobs bot in @BotFather and sets `JOBS_BOT_TOKEN` in `PROD_DOTENV`.
- After deploy: prove one brief lands in the jobs group.
- CLAUDE.md, `docs/PROOF.md` and `.claude/rules/` still describe the kernel. They need their own docs PR.
