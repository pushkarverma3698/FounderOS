# Jobhunt supply-to-apply audit: Tashi's NL supply, apply links, auto-apply, Telegram groups

**Date:** 2026-09-28 · **Scope:** both candidates' pipeline, with Tashi's Netherlands lane in focus
**Branch / PR:** `claude/jolly-babbage-wkueh5` (fixes for items 1, 3 and 5 ship with this document)

## The five answers

| # | Question | Answer | Status |
|---|---|---|---|
| 1 | Why so few NL jobs for Tashi? | Two causes. **(a) Vocabulary:** her classifier dropped 29 fitting Dutch roles in the boards we already poll, more than the 21 it kept. **(b) Corpus:** ~88% of the Dutch finance postings visible on LinkedIn come from employers we do not poll at all. | (a) **fixed here**: 21 → 56 NL roles per 30 days. (b) ranked plan below |
| 2 + 4 | Simplest auto-apply? Antigravity or Claude Code? | Neither is the runtime. Extend the existing Mac apply client. It already opens, fills and records applications, and a human clicks Submit. What it lacks is SmartRecruiters and Workday field maps, which cover 42 of Tashi's 64 NL rows. Use Claude only for supervised long-tail forms. | Plan below |
| 3 | Are we losing apply links? | Yes. **48.6% of postings had no apply-form link.** Workday, Teamtailor, BambooHR and Workable were not recognised (12,089 postings). | **Fixed here**: 51.4% → 82.2% |
| 5 | Bot silent in a group | The bot accepted only `chat.id == TELEGRAM_CHAT_ID`. A group has its own id, so every group update was dropped, the founder's own messages included. | **Fixed here** |

---

## How this was measured, and the limits

This session ran in a cloud container with no SSH to the VPS, and the `founderos` MCP server did not connect. **No production table was read.** So every number below comes from one of these:

- **The production adapters, run live** against every board in `free-ats-boards.csv` marked `NL` (1,166 boards). Same `getBoardRequest` / `listJobs` / `fetchPayload` code the 30-minute sweep runs, without the ETag cache. 39,287 postings, 13 board failures, 34 seconds, $0.
- **Tashi's real filters** over that corpus: `classifyTrack`, `countryFromLocation`, and the 720h window, applied in `filterCandidates` order.
- **LinkedIn's public guest search** as an independent view of the market: 25 queries on her titles, Netherlands, last 7 days, ~100 requests. Plus 40 guest job pages sampled for apply type and language.

Treat the counts as one day's snapshot of the supply. They are not her tracker's contents. The tracker adds dedupe (`known`), body hydration and the screening gates on top.

---

## 1. Why Tashi's Netherlands pool is thin

### Her funnel over our own NL boards, today

```
seen          39,287   postings on 1,166 NL-marked boards
 − undated     1,451
 − stale      19,038   (> 30 days)
 − off-track  18,454   ← her track vocabulary
 − off-market    290
 = kept           53   → NL 21 · India 28 · unknown 4
```

**21 Dutch roles in 30 days** is the whole NL supply her lane can see from the registry. That matches the 2026-09-08 prod measurement of ~9 fresh NL postings/day entering the funnel, once dedupe and screening take their share.

### Finding 1a: the vocabulary was dropping her best-fit roles (fixed)

Among the 18,454 off-track drops, 144 had finance-shaped titles at Dutch or unknown locations. Read by hand, **29 fit a 2.4-year FP&A / KYC / audit candidate**, more than the 21 the lane kept. Examples, all verbatim:

| Employer | Title | Why it was dropped |
|---|---|---|
| BDO | Junior Consultant Internal Audit, Risk & Compliance | only "internal auditor" was a term |
| ING | Financial Crime Compliance Specialist | no "financial crime" |
| Deloitte NL | Analyst IT Audit & Assurance · Analyst Tax MKB · Tax & Legal / Finance Strategy juniors | Deloitte titles lead with "Analyst"/"Consultant" |
| BDO | Junior Consultant Tax – WO · Transfer Pricing (×2) | no tax-consulting terms |
| PwC | Consultant Indirect Tax · Consultant Finance, Publieke Sector | " |
| Rabobank | Finance Specialist | " |
| IFS · SWARCO | Assistant Controller · Regio Controller | only "business/financial controller" |
| Adyen | Compliance Officer – Growth Programs | only "compliance analyst" |
| Topcon | Accounts Payable / Receivable Specialist EMEA | no AP/AR terms |

**Why the 2026-09-07 audit found only one such miss:** it measured a corpus that was mostly tech employers. Deloitte NL, BDO, PwC, Rabobank, NN, Baker Tilly and RSM have joined the registry since. Against their postings, vocabulary is what limits her funnel.

**Fix shipped:** 47 whole-phrase terms in `profiles/wife-nl-finance-terms.ts`. Every term is pinned to its real title in `tests/unit/jobhunt/tashi-track-recall.test.ts`. The obvious broader words were tested and rejected, because each one matched something wrong in the same sweep:

- bare `controller` → "Design of integrated logic controller"
- bare `tax` → "Account Manager Tax & Trade"
- `compliance specialist` → "Export Compliance Specialist"
- bare `assurance` → "Quality Assurance Officer"

The rejected words are pinned as negative tests.

**Re-measured on the same corpus:** kept 53 → **111**; **NL 21 → 56**, unknown 4 → 8, India 28 → 47. Of the 39 new NL/unknown rows, ~35 fit. The rest are:
- one internship ("Stage IT Audit & Assurance")
- two senior titles the level gate exists to catch ("Group Controller", "Transaction Monitoring Scenario Expert")
- one borderline IT-risk role (bunq "Technology Risk Officer")

These terms feed the free-lane classifier only. The paid Indeed query (`titles`) is untouched.

### Finding 1b: the corpus is missing most of her market (not fixed; plan below)

LinkedIn guest search, her titles, Netherlands, **last 7 days: 673 unique postings from 464 employers.** This is a lower bound, because guest pages stop near 40 results per query.

For scale: our boards give her 21 Dutch roles in *30 days*.

Matched strictly by normalised employer name, **only 50 of those 464 employers (78 postings, 11.6%) are in our registry.** The strict match under-counts, for example "Forvis Mazars in the Netherlands" against our "Forvis Mazars", so the true coverage is somewhat higher. Even so, the large majority of her market is on boards we never poll.

Largest missing posters that week: **ABN AMRO (7), KPMG Nederland (6), Moore MKW (9), Forvis Mazars NL (5), ASN Bank (4), Van Lanschot Kempen (4), Flynth (4), EY (3), Essent (3), Kraft Heinz (3), Royal FloraHolland (3), Belastingdienst (3).**

Recruitment agencies posted 70 of the 673 (Michael Page, Robert Walters, Impactsearch, EMEA Recruitment, Talent&Pro, Undutchables-class firms).

### Finding 1c: most Dutch finance postings are written in Dutch

Of 40 sampled LinkedIn postings, **31 were written in Dutch** (keyword heuristic, approximate) and **10 explicitly required Dutch** (strict regex, under-counts).

`extractLanguage` (`extract.ts`) reads a *stated* requirement only. A posting written entirely in Dutch that never says "Nederlands vereist" therefore passes as "No Dutch-language requirement mentioned."

For Tashi this is a precision leak today, and it limits recall tomorrow: Dutch-titled roles (financieel analist, controller bedrijfsvoering, boekhouding) were deliberately **not** added. **Whether they should be depends on her Dutch level, which is a founder answer.**

### Hypotheses tested and ruled out

| Hypothesis | Mechanism real? | Measured cost today |
|---|---|---|
| Workday "2 Locations" / "11 Locations" is read as a foreign country and dropped before the detail fetch | Yes: `countryFromLocation("2 Locations") → other` | **31 such rows; 0 were Dutch** once resolved through the detail payload |
| Small Dutch towns (Capelle a/d IJssel, 's-Gravenhage, Ede, Oss …) fall through the gazetteer | Yes: 19 real towns resolve to `other` | **1 row** (a "Netherlnads" typo). ATS location strings nearly always carry a big city or the country |

Neither is worth code today. Both are recorded here so nobody spends a day on them.

### Precision noise already in her queue

These titles pass her filters today and should not:
- "Medical Devices Auditor – High Risk Software" (bare `auditor`)
- "Senior Technical Due Diligence Consultant – Bouwkundig Adviseur" (construction; bare `due diligence`)
- "Coordenador de Planejamento Financeiro e Análise (FP&A)" (Brazil, location unknown)
- "Financial Controller – Working Student"

They are small, but each one is a row she has to read and reject.

### Ranked plan for the supply gap

| # | Change | Effort | Buys | Who |
|---|---|---|---|---|
| **S1** | Vocabulary (this PR) | done | NL 21 → 56 per 30 days | — |
| **S2** | Add the missing posters above to `docs/strategy/data/nl-finance-employers.csv`, then `pnpm jobhunt:import-boards --employers --dry-run`. The existing strict corpus join finds which are on a platform we already poll. | ~1h, $0 | Every hit is polled every 30 min with direct links, forever | Claude, next session |
| **S3** | Weekly LinkedIn **employer discovery**: ~25 guest searches for her titles in NL, keep only the company names, feed them to S2's join. Postings still come from each employer's own ATS, so links stay direct. | ~½ day | Keeps the registry tracking who is hiring her profile | Claude; founder OK on ToS risk (low volume, names only) |
| **S4** | Re-enable the metered Indeed lane **for Tashi only, NL only**, every 3 days. The actor bills $0.06 per 1,000 jobs, so her 5 tracks cost cents a month. When present, store `urls.external` (the employer link) instead of `urls.indeed`. | ~1h | The only source that reaches Dutch employers on their own career sites (ABN AMRO, KPMG, EY) | **Founder approval**: paid crons were switched off 2026-08-21 |
| **S5** | Language: once her Dutch level is known, either (a) flag a Dutch-written body as "Dutch unstated", or (b) add Dutch titles | ~2h | Precision now, or a much larger recall later | **Founder answer** |
| **S6** | Precision: qualify bare `auditor` and `due diligence` for her profile; drop "working student"/"stage" titles | ~1h | Fewer rows to reject by hand | Claude |

---

## 3. Apply links: are we losing the direct portal link?

`/draft` and `tailor_cv` hand out `getApplyUrl(row.url)`: the application form when the ATS is recognised, the posting page otherwise. Recognition went through `extractBoardToken`, which knew 7 platforms.

Checked against every posting in today's NL sweep:

| Platform | Postings | Form link before | After |
|---|---:|---:|---:|
| Workday | 8,549 | **0** | 8,549 |
| Workable | 2,636 | **0** | 2,636 |
| BambooHR | 506 | **0** | 506 |
| Teamtailor | 398 | **0** | 398 |
| Greenhouse | 16,864 | 10,358 | 10,358 |
| SmartRecruiters | 3,871 | 3,871 | 3,871 |
| Ashby | 2,629 | 2,629 | 2,629 |
| Lever | 1,956 | 1,956 | 1,956 |
| Recruitee | 1,619 | 1,137 | 1,137 |
| Personio | 259 | 259 | 259 |
| **Total** | **39,287** | **20,210 (51.4%)** | **32,299 (82.2%)** |

- **Workday / Teamtailor / BambooHR** had no recogniser, although each adapter already knew its form URL. Workday is where ING, Rabobank, NN, PwC, Baker Tilly, RSM and Vistra live. Fixed in `board-token.ts`; every one of the 9,453 URLs now yields its registry token exactly.
- **Workable** postings arrive as account-less short links (`apply.workable.com/j/<code>`). Workable's own API names `<link>/apply` as the form (`application_url`, see the adapter fixture). Fixed in `apply-packet.ts`.
  **NOT VERIFIED live:** Workable returned HTTP 429 to this container.
- **Remaining gap (18%) is by design:** Greenhouse and Recruitee boards white-labelled on the employer's own domain (Databricks' `?gh_jid=`, `careers.brenger.nl`). The posting page is the right fallback there, because the form is embedded in it.

Side effect worth having: the board harvest uses the same recogniser. Workday, Teamtailor and BambooHR URLs seen in aggregator feeds (and, if S4 is approved, in Indeed's `urls.external`) can now **grow the registry**. Those are exactly the employers Tashi is missing.

Other link findings, not changed here:

- **Indeed rows store `urls.indeed` ahead of `urls.external`** (`indeed-mappers.ts`). That puts a job-board page where the employer link should be. The lane is off; fold the fix into S4.
- **LinkedIn cannot supply direct links.** Guest job pages mark offsite applications (29/40 sampled) but put the employer URL behind sign-in. Use LinkedIn for discovery (S3), never as the link source.
- **The Mac apply client opens `job.url`, the posting page**, except on Ashby. See A2 below.

---

## 2 + 4. Auto-apply: the simplest route that works

### The constraint that decides it

On **2026-08-25 the founder retired the VPS headless apply lane.** `apply-headless.ts`, `apply-driver.ts`, `apply-fill.ts` and `apply-scrape.ts` are tombstoned in `verify-architecture.ts`, so re-creating them fails CI.

The apply lane is `mac-client/`: Playwright on the laptop. It syncs the ranked queue over SSH, opens each form, fills what it can verify, uploads the tailored CV, and waits. **The human clicks Submit** (ADR-018), and the outcome flows back to `job_applications`.

It already supports Tashi's profile (`profile_id` scoping in `sync.py`).

### Why not Antigravity or Claude Code as the engine

- **Antigravity** takes a GitHub issue and returns a pull request. It has no browser session of hers, no database, and a 30-minute budget per task. Use it to *write* the missing field maps. It cannot *apply*.
- **Claude Code / an LLM browser agent** as the per-application runtime means a model loop on every form. That costs minutes and tokens per application, gives different results on the same form, and needs her logged-in sessions and residential IP anyway. So it would have to run on her laptop, which is where the Mac client already runs deterministically for $0.
  Claude does earn a place **as a supervised fallback for forms no field map covers**: Claude in Chrome, in her own browser, on the long tail.
- **LinkedIn Easy Apply automation:** don't. It breaches LinkedIn's terms and risks her account, and it covers only 11 of the 40 sampled postings. The other 29 go to employer portals, which is the lane the Mac client serves.

### Where the Mac client falls short for Tashi, measured

Her 64 NL/unknown rows from today's corpus, by platform:

| Platform | Rows | Mac client field map? |
|---|---:|---|
| SmartRecruiters (Deloitte NL, BDO) | **30** | no |
| Workday (ING, Rabobank, NN, PwC) | **12** | no |
| Greenhouse | 9 | yes |
| Ashby | 6 | yes |
| Recruitee | 5 | yes |
| Lever / Workable | 2 | yes |

**The client pre-fills 22 of 64 (34%).** The rest open for her to fill by hand.

### Plan, ranked by rows unlocked per hour

| # | Change | Unlocks |
|---|---|---|
| **A1** | SmartRecruiters field map in `mac-client/mac_client/adapters.py`, plus a fixture test | +30 rows → **81%** covered |
| **A2** | Open the form, not the posting: port `applyUrlFor`'s suffix rules into `adapters.py`, as Ashby already is | Fewer clicks on every row |
| **A3** | Workday: map the "My Information" step, prefer "Apply Manually". **Account creation stays human**: every Workday tenant needs its own account and email verification. Use the browser's password manager. | +12 rows |
| **A4** | Dutch field labels in `resolver.py` (voornaam, achternaam, e-mailadres, telefoonnummer, cv, motivatiebrief) | Unmapped Dutch forms |
| **A5** | Tashi's real `apply-profile-wife-nl-finance.json` on the VPS. The template's `work_authorization` was invalid and has been fixed in this PR; as of 2026-09-15 no real profile existed. | Nothing runs for her without it |
| **A6** | Supervised Claude in Chrome for the long tail | Forms no map covers |

A1 plus A2 is roughly one day of work and moves Tashi from ~48 hand-typed fields per application to reviewing a pre-filled form and clicking Submit on four of every five rows.

---

## 5. Telegram: the bot is silent in groups (fixed)

**Root cause.** `telegram.ts` authorised an update only when `ctx.chat.id === TELEGRAM_CHAT_ID`. A group has its own negative chat id, so every group update, including the founder's, hit `"Ignored update from unauthorized chat"` and was dropped without a reply.

**Fix** (`src/gateway/chat-access.ts`, wired in `telegram.ts`):

| Where | Who is answered |
|---|---|
| Your own chat (`TELEGRAM_CHAT_ID`, private or group) | unchanged: every message, addressed or not |
| A chat in `TELEGRAM_ALLOWED_CHAT_IDS` | everyone in it |
| Any other group | **you** (the owner). The first time, the bot replies with the exact `TELEGRAM_ALLOWED_CHAT_IDS=<id>` line that lets the others in |
| Anyone else | dropped silently, as before |

- **In a group the bot only answers when addressed:** a command, an @mention, or a reply to one of its messages. The mention is stripped before the kernel sees the text. People talking to each other never start a paid model turn.
- **Outside your own chat, two things stay yours alone:** approving HITL cards and repo-dispatch buttons, and `/halt /resume /task /newproject /connect`. Everything else is open to a guest in an allow-listed group, because the kernel does not know who is typing: every tool outside `HITL_GATED_TOOLS` runs for them, including `read_emails`, `read_file`, `search_memory` and `edit_scheduled` (which cancels or moves your scheduled posts and tasks without an approval card). Allow-list only chats whose members you would hand your phone to; the group hint says so when you open one.
- **Owner identity:** derived from `TELEGRAM_CHAT_ID` when that is your private chat, because in a private chat Telegram makes the chat id equal to the user id. Set `TELEGRAM_OWNER_USER_ID` if `TELEGRAM_CHAT_ID` is a group.
- Proactive alerts (sweeps, briefs) still go only to `TELEGRAM_CHAT_ID`. Routing Tashi's lane alerts to a shared group is a small follow-up if wanted.

**Telegram-side setting.** With BotFather privacy mode ON (the default), a bot in a group receives only commands addressed to it and replies to its own messages, so plain @mentions may not arrive. For @mentions to work: BotFather → `/setprivacy` → **Disable**, then remove and re-add the bot to the group (the setting only applies on join). The bot-side filter above keeps it quiet regardless.

---

## Verification

| Claim | Command | Result |
|---|---|---|
| Group bug reproduced, then fixed | `npx vitest run tests/unit/gateway/telegram-group-chat.test.ts` | **8 failed** before the wiring; **12/12 pass** after, including a guard found in self-review: when `TELEGRAM_CHAT_ID` is itself a group, it still answers every message there (RED, then fixed) |
| Access rules | `tests/unit/gateway/chat-access.test.ts` | 14/14 |
| Apply links | `tests/unit/jobhunt/apply-url.test.ts`, `board-token.test.ts` | 8 failed before; 45/45 after |
| Apply links on real data | recogniser over all 39,287 URLs of today's NL sweep | Workday 8,549/8,549 · Teamtailor 398/398 · BambooHR 506/506 · Workable 2,636/2,636 |
| Tashi vocabulary | `tests/unit/jobhunt/tashi-track-recall.test.ts` | 29 failed before; 39/39 after, negatives included |
| Tashi vocabulary on real data | her filters over the same 39,287 postings | NL 21 → 56 |
| Template validity | `tests/unit/jobhunt/apply-profile-examples.test.ts` | 2 failed before; 3/3 after |
| Full gate | `pnpm lint && pnpm verify:arch && pnpm verify:doc-claims && pnpm test` | see PR body |

**NOT VERIFIED:**
- **The group fix through real Telegram.** This container has no MTProto tester credentials and no route to the VPS. The tests drive grammy's real middleware with raw updates, which is the strongest check available here. The first real proof is you adding the bot to a group after deploy.
- **Workable `/j/<code>/apply` live.** Workable answered 429 here; the URL shape comes from Workable's own API field.
- **Any production table.** No prod DB access this session.
- `pnpm verify:branch` fails on the harness-assigned branch name `claude/jolly-babbage-wkueh5`. The session was instructed not to push to any other branch. CI does not run this check.
