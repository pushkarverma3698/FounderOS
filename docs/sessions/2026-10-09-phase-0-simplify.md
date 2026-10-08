# 2026-10-09 — Phase 0 of the simplify plan (AG-050, 051, 052, 055)

## What we did

Four briefs from `docs/plans/2026-10-08-simplify-founderos.md` were merged to beta in order (050 → 055 → 052 → 051) and promoted once through #1044 (merge commit d328d636). The deploy took prod to d328d636.

| Task | PR | Live result on prod |
|---|---|---|
| AG-050 cheap models, 4096 output cap, free-only fallbacks | #1041 | `.env` has gemini-3.6-flash / ling-3.0-flash / gemini-3.1-flash-lite, and all 3 fallbacks are nemotron `:free`. Telegram probes answered in 7–23 s with no fallback or 402 in the log. |
| AG-055 in-flight context block | #1039 | NOT VERIFIED live. The probe "which approvals and reminders are still open" answered correctly, but through 4 tool calls, so it does not prove the block. Nothing logs whether the block was built. |
| AG-052 hub stdin exit + deploy cleanup | #1043 | The deploy took a backup (`founderos-20261008-183439.sql.gz`), reset 6 failed fos-job@ units and removed jolly-babbage-job-tracker-1. The second deploy printed "no leftovers to clear". Only cloud-init-hotplugd is still failed. |
| AG-051 daily journeys + health line | #1042 | Deploy installed the 02:30 UTC line and removed the B/C lines. One manual run sent the morning message and stored 8 `agents.journey_runs` rows. Score: J5, A, B, C green; J1, J2, J3 red; J4 not built. |

## What the first morning run found

- J1 red, a real bug: "my work inbox" made the model call `read_emails` with `account: "turicks"`, which has a dead grant. It should have used `work`, which is signed in.
- J2 red, a real outage: the turicks Google grant is `invalid_grant`.
- J3 red, a real bug: `list_prs` output reached the model truncated. The reply listed 6 of 10 PRs and gave 5 different PRs the same AG-031 title. The scorer also has two bugs:
  - It needs `#N`, so table rows like `| 1018 |` miss.
  - It marked the follow-up red although the stored reply names **#923**. A second deploy restarted the bot at 18:38:48, mid-turn, which is the likely cause.
- Health line:
  - The OpenRouter key has a $10 lifetime limit with $0.08 left; the account balance is $9.95.
  - The AI Studio key returns 402 (credits depleted).
  - The Claude CLI probe exits 1. It prints the "no stdin data" warning, so stdin needs `< /dev/null`.
  - The Google red lines print "Using keyring backend: keyring" in place of the actual error.
- Deploy ran twice for one SHA, because two CI runs on main each trigger a Deploy, so the bot restarts twice per promotion.

## Why

The plan's Phase 0 makes the daily driver cheap and observable before anything else is cut. The journeys exist to find exactly the reds above.

## Metrics

- Eval on the AG-050 defaults: overall 63% vs 53% for the Sonnet baseline, at $0.28.
- Gates: #1041 9412 tests, #1039 9437, #1043 9445, #1042 9501. All `pnpm gate` exit 0, and CI was green on each PR and on the promotion.

## Outstanding

- Raise the OpenRouter key limit. When it runs out, every paid call falls through to the free model.
- Re-sign-in for Google turicks and naggar; AI Studio credit.
- Fix the J1, J3 and health-line bugs above (each is a separate task).
- AG-055 needs a log line or trace field that shows the block was built, so it can be verified live.
