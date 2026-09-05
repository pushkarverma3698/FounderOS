# 2026-09-05 — wife_* Telegram commands + three missed-profile bugs

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

## What we fixed (part 2 — same day, found via live prod logs)

The founder tapped `/wife_draft 1` in Telegram right after part 1 deployed.
The row resolved correctly (ING · Financial Risk Specialist — her track), but
tailoring failed CV-fabrication validation ("Stakeholder Management" not in
her base CV) and fell through to the free-text kernel-draft path. **That
draft came back signed "Pushkar Verma."**

Root cause, several layers deeper than part 1's bugs: the kernel compiles
once and reuses every `WorkerSpec.prompt` forever (`getKernel()`'s own doc
comment: "rule #2"). `JOBHUNT_PROMPT` was baked in at **process boot** from
`buildJobhuntPrompt()` called with no argument — defaulting to the founder's
own profile. So *every* jobhunt kernel turn, for either candidate, ran under
a system prompt permanently declaring "You are the Job-Hunt department for
Pushkar Verma... read_cv → read Pushkar Verma's CV...". Part 1's fixes made
the ROW resolve to the right person; the WORKER'S OWN IDENTITY never varied
per turn at all.

Fix (PR #607): `WorkerSpec` gained an optional `promptForProfile(profileId)`
override, resolved per-turn from `configurable.profile_id` — the same
per-invocation config channel `thread_id` already rides (precedented:
`makeToolsNode` already reads `config` this way for HITL gates). No kernel
rebuild needed; every other department is completely unaffected since none
of them set this field. `resolveWorkerPrompt` lives in `worker-protocol.ts`
(not a new file) — that file exists specifically for the LOC-ratchet split
pattern, and reusing it kept `worker.ts` at exactly 400 lines instead of
adding a fourth small kernel file.

**Known remaining gap, explicitly not fixed:** `read_cv` the *tool* is still
hardcoded to Pushkar's CV via `PERSONAL_CV_PATH`/`PERSONAL_CV_DIR` — it
queries `personal-rag`, which has zero concept of Tashi Goyal. The prompt now
correctly says "read Tashi Goyal's CV," but the tool would still hand back
**Pushkar's actual CV content** — a fallback draft for her row could now
carry the right name with the wrong skills, a subtler failure than before.
Fixing it needs `career.ts`'s CV-sourcing rewritten to read a profile's
`baseCvPath` file directly (mirroring what `tailor-cv.ts`'s already-correct
success path does) — a materially different, larger change, deliberately not
rushed into this same PR.

## Metrics

- Part 1 (PR #604): 9 files changed, 262 insertions, 21 deletions.
  Squash-merged to `main` at `3026c1f`.
- Session doc (PR #605): 1 file, 76 insertions. Merged at `237092a`.
- Part 2 (PR #607): 8 files changed, 239 insertions, 10 deletions.
  Squash-merged to `main` at `28b9370`.
- `pnpm gate` fresh on part 2: lint + build + wiring + arch fitness (all 6
  gates at baseline, `loc-budget: 6 = baseline`) + full suite — **3726/3726
  passed**, 340 files.
- Both deploys verified live on the VPS the same way: `git rev-parse HEAD`
  matched, `ActiveEnterTimestamp` showed a fresh restart (not a stale tree
  match — checked seconds, not just "close enough"), `dist/` contained the
  new code, no new errors in the following minutes. Part 1's boot log showed
  `"Telegram command menu published","count":24` (16 original + 8 new).

## Outstanding

1. Live Telegram tap-test: confirm `/wife_jobs` and `/wife_draft 1` resolve
   Tashi Goyal's queue, and that a fallback draft (if one recurs) names her
   correctly — founder-only, needs his phone.
2. **`read_cv` the tool is still hardcoded to Pushkar's CV** (see "part 2"
   above) — the next real gap in this lane. Needs `career.ts` to serve a
   second profile's `baseCvPath` file directly instead of querying
   `personal-rag`.
3. `pipeline-followup.ts`'s day-7/day-14 nudge digest still merges both
   profiles' live applications (same root cause as one of part 1's bugs,
   deliberately left out of scope). Worth a follow-up once her applications
   reach that stage.
4. Wife's sweeps were screening 0 roles per pass as of 2026-09-04 19:01 UTC
   (vs. Pushkar's occasional 1) — unrelated to this change, flagged in the
   prior session, still unresolved.
