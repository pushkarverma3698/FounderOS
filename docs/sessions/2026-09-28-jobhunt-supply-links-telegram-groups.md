# 2026-09-28 — Tashi's NL supply, lost apply links, auto-apply route, Telegram groups

## What we did

- Audited the supply-to-apply pipeline for both candidates against five founder questions. Full
  findings: [`docs/audits/2026-09-28-jobhunt-supply-to-apply-audit.md`](../audits/2026-09-28-jobhunt-supply-to-apply-audit.md).
- No SSH to the VPS from this cloud container, and the `founderos` MCP did not connect, so no prod
  table was read. Measured instead with what runs in prod:
  - polled all 1,166 NL-marked boards with the production adapters (`getBoardRequest` / `listJobs` /
    `fetchPayload`, cache off): 39,287 postings, 34s, $0
  - ran Tashi's own filters over them
  - sized the market independently with LinkedIn's public guest search: 25 queries, 673 postings / 7 days
- First attempt at the sweep went through `sweepBoards()`, and every ETag-cache call waited on the
  absent DB. Rewrote it to call `fetchPayload(..., cache: null)` directly.

## What we fixed

1. **Telegram groups** (`src/gateway/chat-access.ts`, `telegram.ts`). The bot answered only
   `chat.id === TELEGRAM_CHAT_ID`, so every group update was dropped.
   - Now answers: the primary chat (unchanged), chats in `TELEGRAM_ALLOWED_CHAT_IDS`, and the owner in
     any group. The first time, it tells the owner the env line that opens the group to others.
   - In groups it replies only when addressed (command, @mention, reply to the bot).
   - HITL approve/reject, repo dispatch and `/halt /resume /task /newproject /connect` stay owner-only
     outside the primary chat.
   - 8 RED → 12/12 GREEN through grammy's real middleware. Self-review also caught that a group
     `TELEGRAM_CHAT_ID` would have stopped answering unaddressed messages: RED, then fixed.
2. **Apply-form links** (`board-token.ts`, `apply-packet.ts`).
   - Workday, Teamtailor and BambooHR URLs were not recognised; Workable's account-less short links
     could not be.
   - Form-link coverage on the real sweep: 51.4% → 82.2% (Workday 0 → 8,549).
3. **Tashi's vocabulary** (`profiles/wife-nl-finance-terms.ts`). Added 47 whole-phrase terms, each
   pinned to a real dropped title.
   - Her NL pool from boards we already poll: 21 → 56 per 30 days.
   - Broader words that each matched something wrong in the same sweep are pinned as negatives.
4. **Tashi's apply-profile template.**
   - `work_authorization: "orientation-year-permit"` failed the closed-set validator.
   - The detail line said she *holds* a zoekjaar permit, contradicting the founder's 2026-09-08
     correction.
   - Now `unknown`, with truthful text.

## Why

- The 2026-09-07 track audit found one vocabulary miss, against a mostly-tech corpus. Deloitte NL,
  BDO, PwC, Rabobank and NN have been added since, and against them the vocabulary is what limits her
  funnel: 29 fitting NL roles dropped vs 21 kept.
- Two plausible structural leaks were measured and ruled out, and deliberately not coded:
  - Workday "N Locations": 31 rows, 0 Dutch
  - the small-town gazetteer: 1 row
- Auto-apply must extend the Mac client. The founder retired the VPS headless lane on 2026-08-25, and
  CI tombstones it. The client's field maps miss SmartRecruiters (30 of Tashi's 64 NL rows) and
  Workday (12).

## Metrics

- `pnpm lint`, `build:all`, `verify:runtime-assets`, `verify:wiring`, `verify:arch` (loc-budget
  6 = baseline), `verify:doc-claims` (file count 399 → 401 rewritten by `--fix`): all pass.
- `pnpm test`: **4,793 passed / 424 files.**
- `pnpm verify:branch` fails on the harness branch `claude/jolly-babbage-wkueh5`. The session was not
  permitted to push elsewhere, and CI does not run this check.
- New tests: 12 (group chat) + 14 (access rules) + 39 (Tashi recall) + 3 (templates) + 11 (links).

## Outstanding

- **NOT VERIFIED through real Telegram:** no MTProto tester creds and no VPS route here. First proof
  is the founder adding the bot to a group after deploy.
- **NOT VERIFIED live:** Workable `/j/<code>/apply`. Workable returned 429 to this container; the shape
  comes from Workable's own `application_url`.
- Supply plan S2–S6 and apply plan A1–A6 in the audit, ranked. S4 (Indeed for Tashi, cents/month)
  needs founder approval under the 2026-08-21 paid-cron directive. S5 needs Tashi's Dutch level.
- Brain sync after merge (this adds `docs/`).
