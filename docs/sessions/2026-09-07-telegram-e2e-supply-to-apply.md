# 2026-09-07 — driving supply→apply through real Telegram

## What we did

Ran the jobhunt pipeline end to end through the **real Telegram transport** (MTProto, sending as
the founder) instead of calling tools over SSH, and measured **800 messages** of the founder's
actual chat history rather than reasoning about what the bot "would" send.

MTProto is configured on **prod only** — `TELEGRAM_TESTER_API_ID` / `_API_HASH` / `_SESSION` live in
`/opt/founderos/.env` and are absent from the laptop `.env`. So the harness runs from the VPS:

```bash
ssh founderos-vps 'cd /opt/founderos && node --env-file=.env --import tsx/esm \
  scripts/telegram-tester.ts send "/jobs tashi" --wait 90'
```

Every defect below was found this way. **The unit suite was green throughout** — 3,788 tests passing
while five of these were live in production.

## What we fixed

Five defects, each with a failing test written first. PRs #629 and #630, both merged to `main` and
deployed (`4059732`, service `ActiveEnterTimestamp` 2026-09-07 16:31:32 UTC).

| # | File | Defect |
|---|---|---|
| 1 | `src/tools/jobhunt/country.ts` | Hardcoded NL/IN fallback ignored the profile, so Indian roles entered Tashi's NL-only queue as a real market code, survived `filterCandidates` (which drops only `other`), consumed body fetches and every gate, then died at the legal gate |
| 2 | `src/tools/jobhunt/skills.ts` | Alias matcher rejected plurals: the base CV's "vector database**s**" failed to ground "Vector Database", so `verifyCvClaims` blocked a **truthful** application |
| 3 | `src/tools/jobhunt/sweep-heartbeat.ts` | The alive ping returned `initialHeartbeat()`, which zeroed `zeroPassStreak` — re-arming the ⚠ funnel alert every 3h, for ever |
| 4 | `src/tools/career.ts` | `read_cv`'s description said "Read *Pushkar Verma's* CV", so the planner never considered it for a question about Tashi |
| 5 | `src/gateway/kernel-boot.ts` | The **jobhunt department** description did not claim CV questions by candidate name, so the planner routed them to `personal` — whose toolbox has no `read_cv` at all |

Two diagnostics were also structurally unable to answer the question they exist for:

- `scripts/audit-track-coverage.ts` hardcoded the default profile in `classifyTrack(title)` and
  `countryFromLocation(location)`. The one tool for "why is this funnel dropping roles?" could only
  ever be pointed at Pushkar. Now takes `--profile`, and exits on an unknown token rather than
  silently auditing the wrong person.
- `scripts/telegram-tester.ts read` dropped the message date. Message ids are not a clock, so
  "how often does this alert fire?" was unanswerable from the founder's own chat — which is why a
  repeating alert had gone unnoticed. Now prints ISO-8601 per message.

## Why

**Defects 4 and 5 are the lesson.** The previous session added `profileId` to `read_cv`'s *schema*
and verified it by calling `.execute()` over SSH. That proved the tool. It did not prove the planner
would ever reach it — and it would not have, through two separate layers:

1. the tool's own **description** still said it was Pushkar's CV (#629), and
2. the **department** that owns the tool never won the routing contest (#630).

Asked "What is Tashi CV background?" over real Telegram, prod answered **"CV Background: Missing"**
about `/opt/founderos-data/cv/cv-wife-base.md`, a file that exists. After #629 deployed it *still*
answered "Unable to find Tashi's CV" — calling `search_personal_rag` and `list_dir`, never `read_cv`.
Only #630 fixed it.

This is CLAUDE.md rule #24 paying for itself: **a tool-level test proves the tool, not the reply the
founder sees.** Three layers had to be right and only two were, twice in a row.

**Defect 3 is the noise rule failing in the direction it was written to prevent.** `sweep-heartbeat.ts`
opens by warning that 48 identical pings a day trains the founder to swipe the channel away. The
funnel alert then fired on a 6.5-hour loop — including **13 times for Pushkar in a window where his
lane passed 83 genuine new roles**. An alert that says the funnel "may be restricted or closed" while
roles pass every thirty minutes is not a signal.

**Defect 2 was sitting on the last mile.** 21 of 22 tailor attempts in prod had failed at the
fabrication guard, against 2 applications ever sent — and at least some of those were the guard
rejecting claims the CV genuinely made, defeated by an English plural.

## Metrics

**Why Tashi's lane is quiet — measured, not guessed.** `audit-track-coverage.ts --boards 120`, same
4,511 postings, both profiles:

| | Pushkar | Tashi |
|---|---|---|
| classified on-track | 907 (20.1%) | 73 (1.6%) |
| of those, in-market | 182 | 10 |

Of the **174 NL postings** her classifier dropped, exactly **8** were finance-shaped, and only **one**
was both in range and genuinely missed ("Finance Operations Specialist", Utrecht). The rest were
CFO/Director/Head-of roles far above her 2.4 years, or quant-risk roles outside her tracks.

**It is not her vocabulary. It is the board registry** — 1,297 tech-company ATS boards, of which only
3.9% of postings are in the Netherlands at all, and NL tech companies post roughly one junior finance
role per fifty engineering roles.

**Telegram, measured over 5.7 days (800 messages, 2026-09-01 23:00 → 2026-09-07 15:40 UTC):**

| Message | Pushkar | Tashi |
|---|---|---|
| 🎯 new roles passed (actionable) | 83 | 1 |
| ⚠ funnel alert (all false) | 13 | 6 |
| ✅ alive ping | 9 | 6 |

`pr-brain` "Claude Code auth expired" accounted for **411 of the 800 messages — 51% of the channel.**

**Free sweep, per 30-minute tick (prod, 2026-09-07 15:01):** 1,297 boards polled **once** and screened
for both profiles. 46,878 postings seen → Pushkar 500 fresh/on-track/in-market, Tashi 64. Both
profiles are messaged independently; neither lane can silence the other.

**The apply funnel (`agents.job_applications`, all time):** 1,409 screened · 22 tailor attempts ·
**21 failed, 1 tailored** · 2 ever applied. Tashi: 81 rows, **0 tailor attempts ever**.

## Outstanding

1. **The CV tailor invents skills from the job ad.** Two `/draft 1` runs produced two different
   fabrications ("Vector Database" — since fixed as a false positive; then "ETL", which
   `grep -ioc etl /opt/founderos-data/cv/ai/cv.md` confirms is genuinely absent). The guard is now
   behaving correctly; the tailoring prompt is the remaining blocker on every application.
2. **Tashi's 56 unlawful India rows are still in the tracker.** Fix #1 stops new ones; it does not
   clean up the existing rows, which are the entire visible content of her brief.
3. **Her board registry needs finance employers** (Big 4, banks, insurers, shared-service centres) —
   the measured constraint above.
4. **Fix #3 cannot be confirmed by observation yet.** The alert fires at most every ~6h; the code
   path is covered by a test that reproduced the 4-alerts-per-day loop before the fix. Confirm no
   ⚠ funnel alert appears in the chat over the next 24h.
5. **A stale local branch `fix/vps-infra-and-stability`** (8 commits, unpushed) carries a judge-model
   change from 2026-09-06 that is now wrong — it lands on a dead model's paid variant, and the
   OpenRouter balance is $0. Needs review before anyone merges it.
