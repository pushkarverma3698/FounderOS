# 2026-09-05 — wife_* Telegram commands + two missed-profile bugs

## What we did

- Audited every Telegram-facing message in the gateway (~78 `ctx.reply` call
  sites across 10 files) at the founder's request, after he reported
  `/profile` only ever showing his own record.
- Registered 8 static Telegram commands — `wife_jobs`, `wife_csv`,
  `wife_draft`, `wife_ask`, `wife_applied`, `wife_replied`, `wife_rejected`,
  `wife_profile` — so a second candidate's queue is reachable from the ☰ menu
  instead of only via the `<cmd> wife ...` space-argument form, which existed
  but was invisible in the one surface (`command-menu.ts`) built specifically
  to fix "how do I know what commands exist". Row numbers stay a typed
  argument (`/wife_draft 1`), since Telegram's `setMyCommands` needs a finite,
  static list — a command per row number is not representable there.
- Implemented via `withForcedProfileToken(ctx, "wife")`
  (`jobhunt-profile-arg.ts`), which forces `ctx.match` before delegating to
  the base handler, so every `wife_*` command runs the exact parsing path
  `<cmd> wife ...` already used — no second parser to drift.

## What we fixed

Two real correctness bugs, same class as the multi-profile gaps already
closed in PR #602/#603:

- `/replied` and `/rejected` never resolved a profile at all —
  `listLiveApplications` filtered only by `tenant_id`, which both profiles
  share. Row numbers came from a merged, interleaved list of both
  candidates' live applications, so marking "row 2" could silently touch the
  wrong person's application.
- `/ask` had the identical gap via the shared `handleRowCommand` — unlike
  `/draft`, it never called `resolveProfileArg` and always read the default
  profile's brief regardless of what was typed.

Both now resolve the named profile the same way `/jobs`/`/csv`/`/draft`/
`/applied` already do. `listLiveApplications`'s new `profileId` filter is
opt-in (`undefined` = prior behavior) — `pipeline-followup.ts`'s digest is
not profile-scoped either, and fixing that was named as out of scope rather
than silently pulled in.

## Why

The founder's actual question ("wife profile view change is not coming")
turned out to be correct-behavior-by-design (bare `/profile` always defaults
to his own queue) rather than a bug — but auditing the surrounding commands
to answer "how do I access this" surfaced two commands that were silently
wrong for a second profile, not just hard to discover. Shipping the new
`wife_*` commands on top of `/ask`'s unfixed gap would have made
`/wife_ask` itself misleading (it would have kept answering about his brief),
so the fix was load-bearing for the ask, not scope creep.

## Metrics

- `pnpm gate`: lint + build + wiring + arch fitness (all 6 gates at
  baseline) + full test suite — 3717/3717 passed, 338 files.
- 9 files changed, 262 insertions, 21 deletions (PR #604, squash-merged to
  `main` at `3026c1f`).
- Deploy verified live on the VPS: `git rev-parse HEAD` = `3026c1f`,
  `ActiveEnterTimestamp` moved to a fresh restart (not a stale tree match),
  `dist/` contains the new command wiring, and the boot log shows
  `"Telegram command menu published","count":24` (16 original + 8 new).
  No new errors in the first 5 minutes post-restart (the only errors logged
  were pre-existing Gmail/Calendar OAuth probe failures, unrelated).

## Outstanding

1. Live Telegram tap-test: confirm `/wife_jobs` and `/wife_draft 1` resolve
   Tashi Goyal's queue when actually typed in the chat (founder-only — needs
   his phone).
2. `pipeline-followup.ts`'s day-7/day-14 nudge digest still merges both
   profiles' live applications (same root cause as the bug fixed here,
   deliberately left out of this PR's scope). Worth a follow-up if the wife's
   applications reach that stage.
3. Wife's sweeps were screening 0 roles per pass as of 2026-09-04 19:01 UTC
   (vs. Pushkar's occasional 1) — unrelated to this change, flagged in the
   prior session, still unresolved.
