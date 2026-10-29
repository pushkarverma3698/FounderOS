# Job search as a SaaS for students: audit and phased plan (2026-10-22)

**Status:** Draft. Waiting on the founder decisions in §12.
**Code audited:** `origin/main` @ `6c3f9389` (prod). Prod data read-only on 2026-10-22.
**Depth:** this file is docs. Every build PR in Phases 1–2 is **Full** depth: it touches auth, tenant isolation, personal data and billing.
**Brief:** [AG-065](../antigravity/AG-065-student-level-preference.md), the first Lite piece Antigravity can take.

## 1. Answer

1. **Yes, the engine can be a SaaS.** Finding and screening jobs is deterministic code with no LLM in it, and fetching is global, so a new user costs close to $0 in supply. That part generalises.
2. **The parts that hold people do not.** Profiles are TypeScript constants, the tenant is hardcoded `turicks` in 7 places, the daily digest for every profile goes to one Telegram group, and documents have no per-user prefix. This is a rebuild, not a config change.
3. **The data does not yet show the product works.** Prod has 2 rows at `applied` out of 6,186 screened, and no interview stage at all. The interviews you and your wife got are real, but they live outside the system. Before anyone pays, the product has to record outcomes.
4. **Students are a different buyer from you two.** The pipeline rejects internships, graduate schemes and working-student roles on purpose (`seniority.ts`, `experience.ts:221`). Career level has to become a per-user preference. That is AG-065. Even with that gate open, supply is thin: the boards carry about 30 early-career NL postings a week across all fields, so one student's field gets 3–8 (§3.2). Student supply has to grow before the pilot, not after.
5. **Launch international students in the Netherlands first**, Indian early professionals going abroad second, and Indian students for Indian jobs last, once a licensed India feed passes a supply trial. Billing goes on the web: Telegram requires Stars for digital goods sold inside a bot or Mini App.

## 2. What exists today

| Part | Today | Ready for many users? | Change for SaaS |
|---|---|---|---|
| Supply | 10 ATS adapters (Ashby, BambooHR, Greenhouse, Lever, Personio, Recruitee, SmartRecruiters, Teamtailor, Workable, Workday), 4 aggregators (Arbeitnow, Himalayas, Jobicy, Remotive), 3,223-board registry, all $0. Apify lanes dormant since 2026-08-21 | Yes, fetch is global | Store postings once, globally; match per user |
| Screening | Pure gates: sponsor register, IND salary, years, title level, Dutch, country, permit route | Partly. Rules are NL-only and tuned for two people | Per-market rule packs; level as a preference |
| Profiles | `PUSHKAR_PROFILE` and `wife-nl-finance.ts`, registered at boot | No | `student_profiles` table built from `JobSearchProfileSchema` |
| Tenancy | `tenant_id` column on some tables, value hardcoded `turicks` | No | `user_id` on every row that holds a person's data, plus Postgres RLS |
| Auth | Telegram Mini App `initData`, with a fallback to the founder's chat id (`miniapp-auth.ts`) | No | Google sign-in on the web, as [ADR-006](../decisions/006-auth-strategy.md) already chose, with an email magic link for students without Google; Telegram linked as a channel |
| Alerts | One digest for all due profiles, sent to one jobs group (`alert-digest.ts` `sendDueDigest`) | No, it would leak one user's jobs to another | Per-user digest per channel |
| Apply | Form scraper, answer store, dossier, CV tailoring, cover letters, Mini App submit (28 of 57 no-bot-check forms, PR #1235) | Prepare: yes. Submit: founder-only | Students get prepare and copy panels; they submit in their own browser |
| Documents | S3 keys with no tenant, `deleteFile` never called, local files at 0600 unencrypted | No | Per-user prefix, encryption at rest, real delete |
| Cost control | `BUDGET_DAILY_USD` (default 5.0) has no reader | No | Per-user monthly cap enforced before each LLM call |
| Runtime | One systemd process, node-cron, sequential per-profile loop, one Chromium | Fine to ~10 users | Postgres-backed queue (e.g. pg-boss), Chromium concurrency cap |

## 3. Supply audit

### 3.1 What we poll and who it serves

| Registry market | Boards | Serves a current profile? |
|---|---:|---|
| UK | 1,799 | No |
| NL | 1,166 | Yes |
| IN | 218 | Yes (`india-local`) |
| DE | 73 | No |

58% of the boards polled every 30 minutes serve nobody today. For a SaaS that is an asset: UK supply is already wired, so a UK rule pack costs no new adapters.

### 3.2 Student-level supply

Live sweep on 2026-10-22: all 3,223 boards through the production adapters, $0, 311 s, 81,073 postings, 97 board failures (50 of them Personio). The ETag cache was stubbed, so nothing was written. Country comes from the job's location text, with US and Canadian places that share UK city names excluded. "Early-career" means `isEarlyCareerTitle`, the same test the Experience gate rejects on. The 4 aggregators are not included.

| Job's country | Postings, last 30 days | Early-career, last 30 days | Share | Early-career per week |
|---|---:|---:|---:|---:|
| NL | 1,369 | 128 | 9% | ~30 |
| UK | 4,251 | 187 | 4% | ~44 |
| DE | 1,628 | 144 | 9% | ~34 |
| IN | 2,171 | 36 | 2% | ~8 |

Early-career postings in the last 30 days, by field (title keywords):

| Field | NL | UK | DE | IN |
|---|---:|---:|---:|---:|
| Finance | 25 | 5 | 9 | 0 |
| Software and data | 13 | 31 | 13 | 8 |
| Marketing, sales, business | 36 | 56 | 63 | 6 |
| Design and product | 3 | 8 | 1 | 6 |
| Engineering (not software) | 3 | 19 | 7 | 2 |
| Other (HR, legal, facilities, Dutch-titled campaign roles) | 48 | 67 | 51 | 14 |

What this means:

1. **One field gets 3–8 early-career postings a week in NL.** A finance student sees about 6 a week and a software student about 3, before any sponsor, salary or language gate. Three relevant matches a day is out of reach on today's corpus.
2. **Many NL postings are Dutch-language.** bol.com, Crisp and WPP Media post `stage` roles with Dutch titles. An international student who doesn't speak Dutch sees fewer still.
3. **The 128 come from 93 employers**, led by De Brauw (27), bol.com (22), Picnic (21), Crisp (17) and Deloitte NL (15). Graduate programmes at the large Dutch employers are missing because those employers are not on the boards we poll (§3.3 item 4).
4. **India has 36 a month.** That confirms segment C waits for a licensed feed.

`postedAt` is the last update on some platforms, which inflates 7-day counts. The weekly column is the 30-day count divided by 4.3.

Prod, last 30 days: 69 early-career rows were stored and rejected (Pushkar: NL 27, IN 9, unknown 25; Tashi: NL 6, IN 1, unknown 1). This is a floor. A posting only reaches the table if its title already matched one of the two experienced-hire track vocabularies.

### 3.3 Problems, ranked

1. **Student roles are filtered out by design.** `isEarlyCareerTitle` rejects every intern, graduate, trainee, working-student and `stage` title. That is correct for you two and wrong for every student.
2. **Track vocabularies are personal.** `track-vocabulary.ts` and `wife-nl-finance-terms.ts` hold terms written for two careers. A student in marketing or mechanical engineering matches nothing. Tracks must come from a shared catalogue the student picks from.
3. **India supply is thin and the big sources are closed.** 218 IN boards, mostly product companies. Naukri's and LinkedIn's terms ban scraping, and mass fresher hiring (service firms, campus drives) is not on public ATS boards. A licensed feed (Adzuna India, JSearch, TheirStack) is the only legal bulk route. Cost and coverage are NOT VERIFIED until a trial.
4. **Big Dutch employers are invisible.** ABN AMRO, KPMG, EY, Aegon and others run SuccessFactors, Taleo, Phenom or their own sites (`docs/audits/2026-10-05-jobhunt-daily-supply-audit.md`). Graduate programmes cluster at exactly these employers.
5. **Dedupe ignores location.** `dedupeKey` is `company::title`. "Graduate Analyst" in Amsterdam and in London become one row, which hides real openings once users span markets.

### 3.4 Improvements, by gain per hour

| # | Change | Gain | Cost |
|---|---|---|---|
| 1 | Level preference (AG-065) | Unlocks every student role already fetched | ~1 day, $0 |
| 2 | Shared track catalogue (~20 student fields, terms per field) | Matches for students outside tech and finance | ~2 days, $0 |
| 3 | Location in the dedupe key, on the new global postings table | Correct per-market counts | Part of the postings table work |
| 4 | Graduate-programme pages for the top ~50 NL graduate employers, via the existing board probe and a sitemap adapter | The roles students want most | ~3 days; one adapter per front end |
| 5 | Supply trial for NL and India: one licensed feed, 2 weeks, measured matches per user per week | Decides whether NL students get enough matches and whether India-for-India can launch | Paid; founder approval. Feed coverage and price NOT VERIFIED |

## 4. Segments and launch order

You chose all three. The data model serves all three from day one. Markets open one at a time, when a market shows at least 5 relevant matches a week for the median pilot user. Today's corpus gives one NL field 3–8 early-career postings a week before any gate (§3.2), so NL needs §3.4 items 4 and 5 before pilot invites go out.

| | B. International students in NL | A. Indians going abroad | C. Indian students for India |
|---|---|---|---|
| Who | Non-EU students at Dutch universities, final year or orientation year (`zoekjaar`) | Final-year students and early professionals in India targeting NL, EU or UK | Final-year students and recent graduates in India |
| What blocks them | Sponsor register, salary criterion, Dutch-language roles, few graduate listings in English | Sponsorship, salary thresholds, no local network | Volume, campus drives, service-firm hiring outside ATS boards |
| What we already have | NL rules, sponsor register, Dutch gate, 1,166 NL boards, the `zoekjaar` permit basis | The same NL rules; UK boards polled but no UK rule pack | 218 IN boards, `india-local` route, `pay-india.ts` |
| Weak point | Students need the level preference and student tracks | For a fresh graduate abroad, the 2026 HSM criterion (under 30: €4,357 a month) rules out most junior roles. The reduced criterion (€3,122) needs a qualifying degree. This segment works for people with 1–5 years of experience, like you and your wife, more than for students | Supply. Unproven until the feed trial |
| Price hypothesis | €9–19 a month | ₹299–499 a month | ₹149–299 a month |
| Order | First | Second | Third, only after the supply trial |

The HSM figures come from `criteria.ts`. Which degrees qualify for the reduced criterion is NOT VERIFIED; confirm on ind.nl when the NL rule pack is written.

## 5. User journeys

| # | Journey | What the student does | What the system does |
|---|---|---|---|
| J1 | Sign up | Opens the link from you, signs in with Google or email, confirms they are 18 or older, accepts the terms | Creates the user; no profile yet |
| J2 | Onboarding (under 5 minutes) | Uploads a CV, picks market, level, up to 3 fields from the catalogue, permit status, languages | Parses the CV into a draft profile; shows the first 10 matches before asking anything else |
| J3 | Daily matches | Opens the web app or a Telegram, WhatsApp or email alert; saves, dismisses or prepares | Per-user digest; every rejection shows its reason (rule #26) |
| J4 | Prepare an application | Taps Prepare on a saved match | Tailored CV summary and cover letter; scrapes the form; fills answers from the answer store; flags unknown questions |
| J5 | Submit | Opens the employer form in their own browser and submits, copying from the answer panel | Records "applied" when the student taps I applied |
| J6 | Follow up and outcome | Marks interview, offer or rejection; gets a follow-up reminder | Outcome events feed matching quality and the pilot's success numbers |
| J7 | Pay | Upgrades on the web when the free tier runs out | Razorpay (India) or Stripe (EU); limits apply from the next prepare |
| J8 | Leave | Deletes the account | Deletes documents, answers, matches and outcomes; keeps only the billing record tax law requires |

## 6. Frontend

1. **One mobile-first web app** served by the jobs process with Hono (already a dependency). Screens: sign-in, onboarding, matches, match detail, prepare, applications board (saved → applied → interview → offer), settings, billing.
2. **Reuse what exists.** The Mini App pages (`apply-home.ts`, `apply-page.ts`, `profile-page.ts`) already render matches, answers and the profile editor. They move behind web sign-in; inside Telegram they keep working through `initData`.
3. **No new framework in Phases 1–2.** Server-rendered pages plus small scripts, as today. Reconsider at Phase 3, when there are more screens and real users to design against.
4. **Alerts are links, not apps.** Telegram (free), WhatsApp (utility template, about ₹0.115 a message, checked 2026-10-22) and email each send a short digest that links into the web app. Nothing is sold inside Telegram.
5. **Browser extension in Phase 3** to fill employer forms in the student's own browser. That is the model the market has settled on, and recruiters are pushing back on bots that submit for people.

## 7. Backend

### 7.1 Data model

| Table | Holds | Key point |
|---|---|---|
| `users`, `sessions`, `identities` | Account, login methods, linked Telegram or WhatsApp | Age confirmation stored with a timestamp |
| `student_profiles` | One row per user per search, from `JobSearchProfileSchema` | Replaces the TypeScript profile constants |
| `postings` | Every fetched posting once, unique on (source, external_id) | Global: not owned by any user |
| `matches` | user × posting, with verdict, reasons and status (new, saved, dismissed, prepared, applied, interview, offer, rejected) | Replaces per-profile `job_applications` rows |
| `outcome_events` | Each status change with time and source | The product's proof |
| `documents`, `answers` | CVs, cover letters, learned answers | Per-user S3 prefix, encrypted |
| `subscriptions`, `usage` | Plan, period, prepares used | Checked before every LLM call |
| `notifications` | What was sent to whom on which channel | Idempotency key per digest |

`ai_call_costs` gains `user_id`. `cv_signals`, `job_digest_state` and `job_lane_heartbeats` gain the user or tenant column they lack today.

### 7.2 Isolation

1. Every query that reads a person's data filters on `user_id` in code.
2. Postgres row-level security on the same tables as a second line, with an app role that cannot bypass it.
3. A CI test seeds two users and fails if any query helper returns the other user's rows.

### 7.3 Work scheduling

The sweep stays one global fetch every 30 minutes. Matching moves from the sequential profile loop in `sweep-runner.ts` to one queued job per user (pg-boss or similar on the existing Postgres; no Redis needed). Chromium form scraping gets a concurrency cap of 2. Each user's digest is its own job with its own idempotency key.

### 7.4 Rule packs per market

| Market | Inputs | State |
|---|---|---|
| NL | IND sponsor register, IND salary criteria, Dutch gate | Built. Criteria table ends 2026-12-31 |
| UK | gov.uk register of licensed sponsors (public CSV), salary thresholds | Not built; boards already polled |
| DE | Blue Card thresholds | Not built; 73 boards |
| IN | No permit rules; salary bands from `pay-india.ts` | Built for one profile |

**Time bomb.** `criteria.ts` has one window, 2026-01-01 to 2026-12-31. From 1 January, `criterionOn` returns null and every HSM-route salary gate flags instead of deciding. IND publishes the new figures in December. Fix: add the 2027 row when published, plus a CI test that fails when the table does not cover today + 21 days (first red on 2026-12-11), so the gap cannot be forgotten.

### 7.5 Hardcodes to remove before a second tenant exists

`turicks` tenant default (`config.ts:37,254`, `job-queries.ts:41`, `profile-config.ts:29,140`, `wife-nl-finance.ts:50`, `schema.ts:64`); the founder bio in `cover-letter-delivery.ts:33-48` and `career.ts`; the wife and Tashi aliases in `bot.ts:68-73` and `command-menu.ts`; the founder fallback in `miniapp-auth.ts`; tenant-less S3 keys in `s3-client.ts:90`.

### 7.6 Cost per user

Supply is shared, so a user adds only matching CPU, storage, alerts and LLM calls on Prepare. Measured on prod (`agents.ai_call_costs`, agent `jobhunt`, all time): 175 calls, $0.119 in total, $0.0019 for the most expensive call. A prepare is about two calls, so 40 prepares a month costs about $0.15 at the worst measured rate. The real cost is your time on support and tuning, which §11 covers.

## 8. Pricing and billing

1. **Pilot is free.** No billing code until Phase 2.
2. **Free tier:** matches and alerts, 5 prepares a month. **Paid:** unlimited matches, 60 prepares a month, follow-up reminders, WhatsApp alerts.
3. **India:** Razorpay with UPI Autopay (2% + GST, checked 2026-10-22). Open checkout in the system browser, not a WebView: UPI Intent fails inside WebViews.
4. **EU:** Stripe, with cards and iDEAL.
5. Prices in §4 are hypotheses. Phase 2 tests one price per market with the first 20 paying users.

## 9. Data protection

1. **India, DPDP Act:** the main duties under the DPDP Rules start 13 May 2027. Under-18s need verifiable parental consent, so signup is 18+ only. Needs a privacy notice, a consent record, a grievance contact and deletion on request.
2. **EU, GDPR:** a lawful basis per purpose, a privacy notice, deletion and export on request, and processor agreements with S3, the LLM providers, Stripe and Razorpay. If the billing entity has no EU establishment, GDPR needs an EU representative (about €150–700 a year).
3. **CV data goes to LLM providers.** Name each provider in the privacy notice, and strip contact details from the text sent for tailoring.
4. **No scraping behind logins and no captcha bypass, ever.** Supply stays public boards and licensed feeds.

## 10. Phases

| Phase | When | Build | Exit criteria (all must hold) |
|---|---|---|---|
| 0. Prove it on you two | Now, ~1 week | IND 2027 guard test; outcome capture (applied, interview, offer, rejected) from the Mini App and Telegram; backfill your real applications and interviews | Your and your wife's last 30 days of applications and interviews are in the table |
| 1. Free private pilot | After 11-01, or now with `unfreeze` per PR; ~4–6 weeks | AG-065 level preference; track catalogue; graduate-programme adapter and the NL + India feed trial (§3.4 items 4–5); users, web sign-in, `student_profiles`, postings/matches split, RLS, per-user digests, per-user documents, deletion | 10 students onboard with no code or env change; median user gets ≥5 relevant matches a week; ≥50% still active after 2 weeks; ≥1 pilot interview; zero cross-user leaks (CI test plus a manual two-account check) |
| 2. Paid beta | ~6 weeks after Phase 1 exit | Razorpay and Stripe, usage limits, WhatsApp alerts, privacy notice and terms, the licensed feed if the trial passed, queue, UK rule pack if segment A needs it | 20–50 users; ≥20% of active free users convert; support under 3 hours a week |
| 3. Scale | Before 13 May 2027 | Browser extension, referrals, campus and placement-cell channels, DPDP compliance complete | Growth beyond your network; DPDP duties met by 13 May 2027 |

PRs touching `src/tools/jobhunt/` carry the `unfreeze` label and a `Moves:` line until 11-01, as PR #1235 did.

## 11. Risks, and the strongest argument against

**The strongest argument against:** the product worked for you two because of deep personal tuning and your daily attention: hand-written track vocabularies, curated employer lists, a Dutch gate tuned to one person. Generic onboarding may give students weak matches, and you become the support and tuning bottleneck for every user. Nothing in the database yet proves the results, and fresher supply on ATS boards is thin: about 30 early-career NL postings a week across all fields (§3.2).

**What answers it:** Phase 0 puts your outcomes in the data, and the Phase 1 exit criteria measure match quality per student before any billing work starts. If the median student gets fewer than 5 relevant matches a week, stop at Phase 1 and fix supply instead of building billing.

| Risk | Mitigation |
|---|---|
| One user sees another's jobs or CV | RLS, per-user digests and the two-user CI test, before user 3 |
| India supply never reaches the bar | Segment C waits for the feed trial; A and B do not depend on it |
| Boards block polling at volume | Polling volume does not grow with users: the fetch is global |
| Students expect one-click apply | Prepare in under a minute, then the extension in Phase 3 |
| Support time | A reason on every verdict; a feedback button per match |

## 12. Founder decisions

1. **The SCALE gate:** [ADR-033](../decisions/033-ai-native-studio-repositioning.md) (accepted 2026-06-17) and `docs/FOUNDER-PROFILE.md` defer any FounderOS SaaS until $5K+ is banked from client work and the system has run reliably for you for 4–6 weeks. Phases 1–3 supersede that gate. Either supersede it (a one-line ADR-033 status change), or keep it and do Phase 0 only, which stays inside it.
2. **Launch order:** international students in NL first, then A, then C (recommended). Or another order.
3. **Segment A definition:** "early professionals with 1–5 years' experience going abroad" (recommended, matches the proof you have) or "students going abroad" (thin supply because of salary thresholds).
4. **Billing entity:** which company bills students in India and in the EU. This decides GST, VAT and whether GDPR needs an EU representative.
5. **Pilot price:** free pilot, then test about ₹299 and €15 a month (recommended), or other numbers.
6. **Start:** Phase 0 and AG-065 now with `unfreeze`, or everything after 11-01.

## 13. Who builds what

| Work | Owner | Why |
|---|---|---|
| AG-065 level preference | Antigravity | Lite: pure gate change, default keeps today's behaviour, tests pin both current profiles |
| Track catalogue | Antigravity, after AG-065 | Lite: data plus matching tests |
| IND guard test, outcome capture | Claude | Small, but touches prod data and the Mini App |
| Users, auth, RLS, postings/matches split, documents, deletion | Claude | Full: auth, tenant isolation, schema migration on prod data |
| Billing | Claude | Full: money and webhooks |
