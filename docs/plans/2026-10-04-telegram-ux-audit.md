# Telegram UX audit — founder DM + jobs group, 2026-09-26 → 10-03

**Status:** draft for founder decision. Nothing here is built.
**Source:** both chats read in full over MTProto (DM: 946 messages, jobs group: 55). The raw dumps stay
in a local scratchpad because this repo is public. Only short excerpts appear below.
**Moves:** C (jobs) and A (coding loop). Most job fixes touch `src/tools/jobhunt/` or `mac-client/`,
which stay frozen until 11-01. See [§6 Freeze decision](#6-freeze-decision-needed).

---

## 0. The result in five lines

1. **The product's core outcome is at zero.** The bot holds 3,759 roles and sent about 300 job
   messages in the DM and 49 in the group. Neither candidate sent an application. The 10-02
   "Jobhunt check" reports 310 and 164 actionable roles, with 0 applied for both.
2. **The bot talks 8× more than the founder.** It sent 845 messages to the founder's 101. 637 of them
   (75%) are machine status: review and dispatch pings, job counts, restart notices. Real replies
   get buried, and the founder learns to stop reading.
3. **The jobs group is built for Pushkar, not Tashi.** Tashi used it once in 7 days. Her own
   commands are named `/wife_*`, the help text says "your wife's queue", and her brief tells her to
   run a shell command on a Mac.
4. **Numbers on screen don't mean what they say.** `/draft 4` pointed at four different companies
   in four alerts. One brief reuses the same row numbers in three sections. In Tashi's brief,
   "DO THIS NEXT `/draft 1`" would act on Pushkar's queue. After one wrong tap, a user stops tapping.
5. **The coding loop works but feels broken.** Failed dispatches end in "✓ 1 action completed and
   verified". `/task <repo>` ignores the argument. A rejected card reads like a crash. The founder
   asked "why not picked up?" five times in one evening.

---

## 1. What FounderOS is for, from the user's seat

Two people use it, and they have different jobs to be done.

| User | Where | What they came for | What success feels like |
|---|---|---|---|
| **Pushkar** (founder) | DM | (a) code shipped while away, (b) where every repo stands, (c) job applications | "I sent one line and got a PR. I check once a day and know what needs me." |
| **Pushkar + Tashi** (candidates) | jobs group | roles worth applying to, and actually applying | "Here are 3 jobs for me today. Tap → tailored CV → apply → done." |

Everything else is plumbing: departments, tools, gates, sweeps and budgets. Right now the plumbing
speaks louder than the product.

---

## 2. Measured evidence (DM, 7 days)

| Bot message type | Count | Who it's for | Problem |
|---|---:|---|---|
| pr-brain + agent-dispatch status | 259 | engineer | ~37 a day; 80 of them between 23:00 and 08:00 IST |
|   ↳ ⚠️ Gate FAILED to complete — oplify-messaging-api#56 | 104 | | every 20 min overnight 09-26→09-28, ends `Log: ~/.claude/pr-brain.log` |
|   ↳ 🧠 Gate done | 61 | | the text has no verdict, so you open GitHub to learn the outcome |
|   ↳ 🧠 pr-brain PAUSED / resumed | 24 | | raw CLI errors ("bubbletea: error opening TTY", model lists) |
| Job pings (🆕 new role, 🎯 N ready, heartbeat, funnel, briefs) | 298 | candidate | 🆕 fires per 30-min sweep, usually "1 new role"; 🎯 is hourly from the Mac and drifts 126→55→96 without changing anything |
| 🔑 Google sign-in expired + 🚀 back online | 80 | founder | the same pair after every restart, with raw `invalid_grant` text (#819 targets this; verify) |
| Replies to the founder's own messages | ~200 | founder | **the only part the founder asked for** |

---

## 3. Psychology behind the fixes

Every task in §5 follows from one of these five principles.

1. **Signal-to-noise sets attention.** When 7 of 10 messages don't matter, the user mutes the chat,
   including the 3 that do. Every message has to pass one test: *does it need the user, or does it
   change what they would do?* If not, it belongs in a digest or behind a command.
2. **One wrong tap loses trust.** A `/draft 4` that tailors the wrong company teaches "the numbers
   lie". The user then stops tapping and starts asking, and the conversion path dies. Stable IDs and
   honest status labels come before new features.
3. **Too many choices stop action.** "166 to apply today · 92 stretch · 65 one question away" across
   8 messages produced zero applications. Three good options with one tap each beat 323 options.
   Show the top 3, and put the rest behind a button.
4. **People use what is addressed to them.** In her own group, Tashi is called "your wife" and told
   to run `cd ~/Projects/...`. That says "this isn't for you." She should see her name, her own
   commands and a path that works on a phone.
5. **Progress brings people back; guilt doesn't.** "118 roles have sat undrafted… drafting is the
   bottleneck" shames the user and doesn't make the next step easier. "You applied to 2 this week,
   1 more hits your goal" gives a reason to come back. Celebrate the action, not the backlog.

---

## 4. Findings by journey

### 4.1 Jobs group — Tashi (C)

- **F1. Commands hit the wrong queue (serious).** Tashi's `/wife_today` brief ends with "DO THIS
  NEXT `/draft 1` — Nexperia". A bare `/draft` resolves to Pushkar's queue, and the body lists
  Nexperia as row 151 or 169. `src/tools/jobhunt/brief-actions.ts:83` prints `/draft N` without
  `profileSelector()`, and lines `:88`, `:94`, `:96` and `:113` do the same. #784 fixed the pushed
  alerts but not the brief.
- **F2. She's addressed in the third person.** The commands are `/wife_*` and the copy says "your
  wife's queue" (`src/gateway/command-menu.ts`). In the shared group she talks to the bot herself.
- **F3. The apply path needs a desktop.** "HOW TO APPLY" says to run
  `cd ~/Projects/founderos/mac-client && .venv/bin/python -m mac_client.apply`
  (`brief-actions.ts:113`). Tashi applies from a phone.
- **F4. Ops messages leak into a family chat.**
  - Each of ~30 🆕 alerts ends "⚠ The job sheet is not set up yet (JOBHUNT_SHEET_ID and
    GOOGLE_SHEETS_CREDENTIALS_PATH are not set)" (`free-sweep-profile.ts`).
  - Heartbeats ("22,379 board checks") and funnel alerts post there too (`sweep-heartbeat.ts`).
  - The brief includes "💰 LAST 3 DAYS $0.00 across 286 collection runs… ledger records no profile"
    (`brief-sections.ts:309`).
- **F5. Candidate data gets mixed.** Tashi's section headers showed Pushkar's "~3.5 shipped" while
  her rows showed 2.4.

### 4.2 Job brief — both candidates (C)

- **F6. Row numbers move.** On different alerts, `/draft 4` named Bosch, DiligenceVault, Vinmar and
  MLH. A row number is a position in a list that changes every 30 minutes.
- **F7. Numbers collide across sections.**
  - One brief numbers APPLY rows 1–61, ONE QUESTION rows 1–218, TOO SENIOR rows 11–84 and NOT
    LAWFUL rows 11–107, so the ranges overlap.
  - The footer says "+214 more one question away — `/draft 5` works", but row 5 there is an `/ask`
    row.
  - "`/draft 11` works on any of them" also appears under barred roles.
- **F8. Labels contradict themselves.**
  - Rows under "ONE QUESTION AWAY" print "✅ Why it's here: every check below cleared".
  - "⛔ NOT LAWFUL — a legal bar" mostly holds seniority items such as "staff seat". The label is
    wrong and alarming.
  - The CV match lists "JavaScript" as missing for a TypeScript developer.
- **F9. Too much at once.**
  - `/jobs` sends about 8 messages of roughly 3k characters each ("showing newest 500 of 3759").
  - Each row repeats every ✅ check.
  - "DO THIS NEXT" sits at the very bottom, after 20k characters.
- **F10. Guilt copy and insights with no next step.**
  - "118 roles have sat undrafted" (`daily-brief.ts`).
  - "WHAT THE MARKET ASKED… missing for 62 days" offers no action such as "add SAP to your CV?".
- **F11. An hourly "N jobs ready" ping from the Mac** (`mac-client/mac_client/notify.py:74`). The
  number barely changes all day, and it lands in the DM instead of where the candidate is.

### 4.3 Coding loop — /task (A)

- **F12. "✓ N actions completed and verified" appears under failures.**
  - Examples: "The dispatch failed… ✓ 1 action completed and verified" and "The mission was not
    completed… ✓ 1 action completed and verified".
  - It happened on 5 failed missions this week. The footer counts every ok receipt, read-only
    ones included (`founderReceiptsBlock`, `src/kernel/synthesizer.ts:113`), so it also appears
    on plain research answers.
  - A green tick under a red outcome is the worst trust signal in the product.
- **F13. A rejection reads like a crash.** Tapping ❌ prints "⚠️ Task stopped at step "s1" —
  hitl_rejected failure in engineering" (`src/kernel/supervisor.ts`, `src/gateway/failure-card.ts`).
  The founder made that choice, so the reply should be "OK, dropped."
- **F14. `/task` ignores its argument and races the founder** (`src/gateway/task-command.ts`).
  - `/task founderos` answered "Which repo? founderos", so the founder learned to type
    `repo:founderos`.
  - A bare `/task` asks "Which repo should I build in?" and then picks FounderOS in the next message
    without waiting for an answer.
- **F15. Dispatch failures blame the founder's input.** On 10-02, 4 of 5 `/task` lines sent between
  16:50 and 17:13 were rejected for "incorrect file paths… evidence missing". `/start` promises that
  "one line is enough", but the brief gate wants file paths the founder doesn't have. #819 fills an
  empty Problem; it's unclear whether path rejections still happen.
- **F16. Tasks get dispatched twice.**
  - On 10-03 between 14:55 and 14:59, issues #29 and #41 were each sent twice.
  - #38 got three identical "Dispatched… task #76" replies.
  - Nothing replies "this is already queued as #77".
- **F17. The bot makes promises it can't keep.** "Got it! I'll monitor Issue #762 and keep you
  posted." No watcher in the kernel backs that sentence. The founder then asked "why not picked up?"
  five times.
- **F18. Review notices read like engineering logs** (`deploy/vps-daemons/pr-brain`).
  - "✅ Reviewing … BRAIN-VERDICT: FAIL" puts a green tick on a fail.
  - "🧠 Gate done — founderos#790 (TEST KEYBOARD)" has no verdict.
  - Test messages ("🔧 TEST PROBE", "Antigravity is thinking/acting… test line 1") landed in the
    founder's real chat.
- **F19. Read-only status checks ask for approval.** A `gh` read showed "🔧 Run command in project?".

### 4.4 Asking questions — trust (A/B)

- **F20. The bot's knowledge of itself is stale or invented.** "What features does FounderOS
  have?" got createSupervisor and createReactAgent (both deleted), "Gemini 2.5 via OpenRouter" and a
  "JARVIS web gateway". Another answer stated a home city for the founder with no source.
- **F21. Raw model errors come back as replies.** On 09-29, three turns in a row returned a Gemini
  400 "exclusiveMinimum" stack, printed twice per message. The same questions worked 15 minutes
  later. #771/#772 fixed the root cause, but model errors are still shown raw.
- **F22. Theatrical openers.** "Mission complete." appeared in front of a tool list.

### 4.5 Discoverability (A/B/C)

- **F23. `/commands` is too long.** It spans 2 messages and 4.6k characters, and every job command
  appears twice (🔹 and 🔸). The tool list (`🧭 Everything I can do`) adds 6 more messages covering
  75 tools.
- **F24. Empty states give no example.** `/focus` answers "no focus set - send /focus <text>", and
  `/projects` answers the same way. `/remind` shows usage only. One tappable example each would
  turn a dead end into a first use.
- **F25. `/status` is thin.** It shows only uptime, approvals and emails. `/where` (#813) is the
  real "where are we": it uses zero LLM and its numbers match GitHub. The founder used it 3 times
  on 10-03. This is the pattern to copy.

### What already works (keep it)

- `/where` and the `/tasks` "🔀 Ready for you to merge" list are short and deterministic, with one
  line per item.
- Since #819, the approval card holds new turns until it's answered ("⏸ Not started: an approval is
  still waiting").
- In `/draft`, "→ Open the posting (this ATS hides the form behind its own button)" is honest and
  specific.
- The quota notice: "⏸️ quota exhausted until 20:57 UTC. #796 is queued and starts automatically".
  It gives the time, says what happens next and asks nothing of you. Every system notice should
  read like this.

---

## 5. Task list

Each task names its outcome (A–D; **/F** = frozen path that needs `unfreeze`), the findings it
fixes, the change and its proof. Tasks are ordered by user impact per hour of work.

### P0 — trust breakers (fix before anything else)

| # | Task | Out | Fixes | Change | Done when |
|---|---|---|---|---|---|
| P0-1 | Profile-qualified commands in every brief | C/F | F1 | `brief-actions.ts`: run `profileSelector()` into every `/draft`, `/ask`, `/applied` line | unit test: a `wife-nl-finance` brief has 0 bare `/draft N`; MTProto read of the group shows `/draft tashi 1` |
| P0-2 | Stable job IDs, not positions | C/F | F6, F7 | each role gets a short stable id; `/draft <id>` keeps working on old alerts; positions are display only | `/draft <id>` from a 3-day-old alert opens the same company |
| P0-3 | Honest result footer | A | F12 | drop "✓ N actions completed and verified" when the mission failed or no gated action ran | golden test: a failed-dispatch reply has no ✓ |
| P0-4 | A rejection says "Dropped" | A | F13 | `hitl_rejected` renders "👍 Dropped. Nothing was sent." with no ⚠️, stage or component | unit test on `failure-card.ts` |
| P0-5 | Fix the labels that lie | C/F | F8 | ONE QUESTION rows print the blocking question; a seniority bar reads "Not your level", not NOT LAWFUL (`brief.ts:306` puts every non-Experience reject under NOT LAWFUL) | brief snapshot test |

### P1 — noise and friction (the week after P0)

| # | Task | Out | Fixes | Change | Done when |
|---|---|---|---|---|---|
| P1-1 | One message per event, quiet hours | A | §2, F18 | pr-brain: FAILED once per head, not per retry; no "Reviewing…"; "Gate done" carries the verdict (✅ cleared / ❌ changes: reason); 23:00–08:00 IST goes to a morning digest unless 🛑 blocked | pr-brain + dispatch messages ≤ 10 a day (now ~37) |
| P1-2 | Batch new-role alerts | C/F | §2, F4 | 🆕 alerts go out 3 times a day; the sheet-not-set-up line is gone; heartbeats and funnel alerts move to the DM | ≤ 5 group messages a day |
| P1-3 | Top-3 brief | C/F | F9, F3 | `/jobs` and `/today` send ONE message: the top 3 apply-today roles with a "📝 Draft" button each, then "Show more" and "CSV" buttons; spend and ops sections move to `/status` | brief is 1 message, ≤ 1,500 characters |
| P1-4 | Tashi's own commands | C | F2, F23 | in the group, read the sender: Tashi's `/today` means her queue; the menu uses her name; `/wife_*` stay as hidden aliases | Tashi sends `/today` in the group and gets her brief |
| P1-5 | Apply from a phone | C/F | F3, F11 | no shell command in the brief; `/draft` sends PDF + link + an "✅ I applied" button that calls `/applied` | the apply loop takes 2 taps on a phone |
| P1-6 | `/task <repo>` and dedupe | A | F14, F16 | a first word matching a repo alias is the repo; never auto-pick after asking; refuse to re-dispatch an issue already queued or in review ("already queued as #77") | unit tests on `task-command.ts` |
| P1-7 | One-liners don't bounce | A | F15 | when the brief lacks paths, file it with "paths: agent to locate" (the "Not verified" hint already exists) instead of rejecting | 5 one-line `/task`s give 5 issues |

### P2 — polish and habit (after the freeze, or as capacity allows)

| # | Task | Out | Fixes | Change |
|---|---|---|---|---|
| P2-1 | Progress, not guilt | C/F | F10 | swap "N roles sat undrafted" for "This week: 2 applied · goal 5", tied to `/goal applications_7d` |
| P2-2 | Gaps lead to an action | C/F | F10, F8 | each market gap ends in a one-tap "add to CV?"; a skill the CV covers by synonym (JS↔TS) doesn't count as missing |
| P2-3 | Empty states with one example | B | F24 | `/focus`, `/projects` and `/remind` each show one tappable example |
| P2-4 | `/commands` on one screen | A/B | F23 | 3 groups of at most 6 commands; Tashi's variants hidden; a "More" button |
| P2-5 | Self-knowledge from code | A | F20 | "what can you do" answers come from the live tool list and `docs/ROADMAP.md`, not memory; no personal facts without a source |
| P2-6 | Model errors in one line | A | F21 | "The model refused that request (schema). Retry?" printed once, with no stack |
| P2-7 | No false promises | A | F17 | strip "I'll monitor / keep you posted" unless a watcher was actually scheduled (a pure-function guard in the synthesizer) |
| P2-8 | Test messages off the real chat | A | F18 | probes post to a test chat, never the founder's DM |

### Already done or in flight: verify, don't rebuild

| Item | PR | State | Check |
|---|---|---|---|
| Restart card and Google alert once per window | #819 | merged, promoted (#821) | 24h DM count of 🚀 / 🔑 after the deploy |
| Approval card holds new turns | #819 | merged | seen working on 10-03 at 19:47 |
| Empty Problem filled from the request | #819 | merged | covers part of F15 |
| Plain words run the real slash commands | #824 | open, CI red | partly fixes F14 |
| `/login` from Telegram | #825, #826 | open | removes the cause of the 🔑 spam |

---

## 6. Freeze decision needed

`src/tools/jobhunt/` and `mac-client/` are frozen (`scripts/verify-pr-scope.ts`). Outcome C was
scoped as "jobhunt works as it is, we just haven't applied". **The evidence says the UX is the
reason nobody applied:** commands that hit the wrong queue, numbers that move, a 323-option brief
and an apply path that needs a desktop. Fixing these is outcome C, not new features.

**Recommendation:** label `unfreeze` on **P0-1, P0-2, P0-5, P1-2, P1-3 and P1-5** only. They are
six small copy and rendering changes that add no new data source. Everything else stays frozen.
Antigravity briefs: [AG-020](../antigravity/AG-020-jobs-brief-trust-fixes.md) (P0-1, P0-5; needs `unfreeze`) and [AG-021](../antigravity/AG-021-honest-reply-footer-and-rejection.md) (P0-3, P0-4; not frozen, can go now).

---

## 7. How we'll know it worked

| Metric | Now (7 days) | Target (14 days after P0 + P1) | Read from |
|---|---:|---:|---|
| Applications sent (both candidates) | 0 | ≥ 5 | `/goal applications_7d` |
| Tashi's own messages in the group | 1 | ≥ 5 | MTProto dump |
| Bot messages per founder message (DM) | 8.4 | ≤ 3 | MTProto dump |
| pr-brain + dispatch messages a day | ~37 | ≤ 10 | MTProto dump |
| "✓ verified" on a failed reply | yes | 0 | golden test |

Re-run this audit on 2026-10-18 with the same dump script.

---

## NOT VERIFIED

- The counts come from one MTProto dump taken 10-03 at 20:20 UTC, before #819 reached prod, so the
  🚀/🔑 pair may already be fixed.
- Tashi's low usage may have causes outside the bot, such as time or preference. This doc treats
  the UX as the likely cause, so ask her.
- Source locations come from grepping message text on `main` @369d320b. No code was run.
- The JS↔TS gap comes from one brief. The matcher code was not read.
