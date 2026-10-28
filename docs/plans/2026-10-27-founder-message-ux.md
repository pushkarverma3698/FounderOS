# Founder message UX: formatting and tap actions for VPS routine messages

**Status:** Proposal. Nothing here is built. No VPS file was edited.
**Date:** 2026-10-27
**Moves:** A. The founder reads each message in 3 seconds and can act with one tap.
**Depends on:** T1 moving the VPS scripts into git (`claude-notify`, `claude-routine`, `routine-verdict`).

## Where we are

1. Every routine message is plain text. No HTML, no Markdown, no buttons.
2. The sender, `claude-notify`, uses the same bot token as `founderos.service`. Its update stream already reaches the jobs bot.
3. The jobs bot answers only `jh:` button taps. Any other tap gets "Unknown action".
4. The fix is a transport change plus one new callback prefix. Nothing needs a new bot.

## What claude-notify can do today

| Capability | Today | Source |
|---|---|---|
| Send text | Yes. Plain text, `disable_web_page_preview=true`. | `/usr/local/bin/claude-notify` |
| `parse_mode` (HTML) | No. The field is never sent. | same |
| `reply_markup` (buttons) | No. | same |
| Split long text | Yes, 3900-character parts. A split can cut an HTML tag, so it must be changed. | same |
| Literal `\n` becomes a line break | Yes. | same |
| Bot token | Same token as `founderos.service` (hashes compared, values not printed). | VPS check, 2026-10-27 |
| Callback taps | The jobs bot long-polls and answers `callback_query:data`. | `src/jobs/bot.ts:144`, `:163` |
| Access gate for taps | Yes. `bot.use` checks the chat for every update, taps included. | `src/jobs/bot.ts:79` |
| Routing for new buttons | Only `jh:` is routed. Other data gets "Unknown action". | `src/gateway/jobhunt-callbacks.ts:29` |
| Callback data limit | 64 bytes. Longer data is refused by Telegram. | `src/gateway/jobhunt-gap-buttons.ts:24` |

**Conclusion:** `claude-notify` can send one plain message to the founder's chat. It cannot send formatted text or buttons. The jobs bot can already receive taps from it. It needs a new prefix and a handler.

## Inventory: every message the founder can receive

Frequency comes from the journal, `sudo -n journalctl --since "7 days ago"`, 2026-10-20 to 2026-10-27. Most failure messages are not logged, so their counts are NOT VERIFIED. They are marked "rare, unlogged".

### Routine runner (`/usr/local/bin/claude-routine`)

| # | Trigger | Current text (shortened) | Frequency (7 days) |
|---|---|---|---|
| 1 | Run hit the usage limit 3 times and will not restart | ❌ X stopped: it hit the Claude usage limit 3 times… / You need to: open it in the Claude app and type continue | rare, unlogged |
| 2 | A paused run woke up again | ⏳ X is running again after a Claude usage-limit pause (HH:MM IST). / Nothing needed from you. | 2 "resumed" lines |
| 3 | Paused run could not restart | ❌ X is paused by the Claude usage limit… / You need to: … / • Error: … | rare, unlogged |
| 4 | Unsaved work exists only on the server | ⚠️ X: unsaved work from the last run is only on the server… / You need to: ask a Claude session to recover it. Don't delete it. / • Folder or Run | 1 push failure, others saved to GitHub silently |
| 5 | Run died before it started | ❌ X did not start today (HH:MM IST). / You need to: … / • Why: … / • Next try: its next scheduled run. | rare, unlogged |
| 6 | Run finished but sent no report | ❌ X ran (HH:MM IST) but sent no report. / Nothing needed from you unless it happens again tomorrow. / • Error: … | rare, unlogged |

### Scheduled routines (their own sessions call `claude-notify`)

| # | Routine | Trigger | Current text (shortened) | Frequency (7 days) |
|---|---|---|---|---|
| 7 | PR digest (`pr-digest-founderos`) | Mon–Fri 08:30 Amsterdam, print mode | ✅ FounderOS: N changes are ready… / You need to: … / up to 3 "• title: reason url" bullets | 7 starts |
| 8 | BachelorHouse morning build | Timer 03:04 UTC; sent when the session ends | Report under 14 lines, "Needs you: N — You need to: …" then plain bullets | 5 starts |
| 9 | Oplify nightly build | Daily 09:30 UTC, session end | Report at most 6 lines, "Needs you: N — You need to: …", then up to 3 "•" bullets | 3 starts |

Rows 8 and 9 come from the job prompts. Their output is produced by the session and was not read in full (see NOT VERIFIED).

### Daily verdict (`/usr/local/bin/routine-verdict`, one message per group)

| # | Headline (line 1) | When | Frequency (7 days) |
|---|---|---|---|
| 10 | ✅ X: today's build is done. N changes ready, all checks passed. | every check passes | 0 in 7 days (no all-ready line logged) |
| 11 | ✅ X: nothing to build today, the task list is empty. | no PRs, empty queue | 1 line 0/0 |
| 12 | ❌ X: today's build did not run (reason). | service failed or did not run in 26 h | rare, unlogged |
| 13 | ⏳ X: the build is paused (usually the usage limit) / still working / waiting for tests | run not finished | rare, unlogged |
| 14 | ⚠️ X: the build is done, but N of M change(s) did not pass the checks. | PRs not ready | the most common verdict: 4 of the 5 logged lines (0/6, 0/1, 4/10, 4/12) |
| 15 | ❌ X: the daily check could not read GitHub / crashed on our side | script or GitHub failure | rare, unlogged |

**Verdict frequency gap:** the schedule is one verdict per group per day (bh 09:30 UTC, oplify 17:30 UTC). The journal shows 5 verdict lines in 7 days (3 bh, 2 oplify). The gap is unexplained. NOT VERIFIED.

**Totals:** 15 message types. None uses `parse_mode` or buttons today. Rows 7 to 9 are plain text with raw URLs.

## Rewritten examples

The names, counts and links in these examples are invented placeholders, not real data.

Format rules used below: line 1 is a bold marker and the result in plain words. Line 2 is a bold "You need to:" or "Nothing needed from you." Then at most 3 bullets. Links are inline (`<a href>`), not raw URLs. Telegram HTML supports `<b>`, `<i>`, `<code>`, `<a>`.

HTML must escape `&`, `<` and `>` in every dynamic value. Titles come from GitHub and can contain them.

### 1. Usage limit stop

```html
❌ <b>Oplify nightly build stopped.</b>
It hit the Claude usage limit 3 times and will not restart by itself.
<b>You need to:</b> open it in the Claude app and type <code>continue</code> after the limit resets.
```

### 2. Resumed after a pause

```html
⏳ <b>Oplify nightly build is running again.</b>
It woke after a usage-limit pause (09:42 IST).
<b>Nothing needed from you.</b>
```

### 3. Could not restart

```html
❌ <b>Bachelor House build is paused by the usage limit.</b>
It could not restart by itself.
<b>You need to:</b> open it in the Claude app and type <code>continue</code>.
• Reason: the account is still out of usage
```

### 4. Unsaved work only on the server

```html
⚠️ <b>Bachelor House build has unsaved work.</b>
It is only on the server, not on GitHub.
<b>You need to:</b> ask a Claude session to recover it. Do not delete it.
• Folder: bachelor-house-backend, last run
```

### 5. Did not start

```html
❌ <b>Oplify nightly build did not start today.</b>
<b>Nothing needed from you</b> unless it fails again tomorrow.
• Why: the Claude background service is not running
• Next try: its next scheduled run
```

### 6. Ran but sent no report

```html
❌ <b>Oplify nightly build ran but sent no report.</b>
<b>Nothing needed from you</b> unless it happens again tomorrow.
• Error: session ended without a final message
```

### 7. PR digest

```html
✅ <b>FounderOS: 1 change is ready to merge.</b>
<b>You need to:</b> merge the change that adds the message formatter.
• <a href="https://github.com/OWNER/REPO/pull/1">Add message formatter</a>: ready to merge
• <a href="https://github.com/OWNER/REPO/pull/2">Fix brain recall</a>: blocked, failing test
• +3 more open
```

Links point at the PR's real URL from `gh pr list --json url`. `OWNER/REPO` above is a placeholder.

### 8. Bachelor House morning report

```html
✅ <b>Bachelor House: 2 tasks finished tonight.</b>
<b>You need to:</b> approve the release to production.
• <a href="https://github.com/OWNER/REPO/pull/3">Promotion to production</a>: ready
• <a href="https://github.com/OWNER/REPO/pull/4">Login fix</a>: merged to staging
```

### 9. Oplify nightly report

```html
⚠️ <b>Oplify: 1 fix is on staging, 1 is stuck and needs you.</b>
<b>You need to:</b> send the staging URL and allow the VPS on ports 80/443.
• <a href="https://github.com/OWNER/REPO/pull/5">Staging fix</a>: passed the staging test
```

### 10. Verdict: all ready

```html
✅ <b>Bachelor House: today's build is done.</b>
2 changes are ready, all checks passed.
<b>Nothing needed from you.</b>
```

### 11. Verdict: nothing to build

```html
✅ <b>FounderOS: nothing to build today.</b>
The task list is empty.
<b>Nothing needed from you.</b>
```

### 12. Verdict: did not run

```html
❌ <b>Oplify: today's build did not run.</b>
Its service failed when it started.
<b>You need to:</b> ask a Claude session why the Oplify build did not run.
```

### 13. Verdict: paused or still working

```html
⏳ <b>Bachelor House: the build is paused</b> (usually the usage limit).
1 of 3 changes is ready so far.
<b>Nothing needed from you.</b> It restarts itself; you get a message if it cannot.
```

### 14. Verdict: not all ready

```html
⚠️ <b>Bachelor House: the build is done, but 2 of 5 changes did not pass.</b>
<b>You need to:</b> ask a Claude session to fix the changes below.
• <a href="https://github.com/OWNER/REPO/pull/6">Add order export</a>: tests failing
• <a href="https://github.com/OWNER/REPO/pull/7">Update checkout copy</a>: missing description
• 3 tasks left in the queue
```

### 15. Verdict: script or GitHub failed

```html
❌ <b>Oplify: the daily check could not read GitHub.</b>
So there is no verdict today.
<b>You need to:</b> ask a Claude session to re-run the Oplify report.
```

## Buttons

Two groups. Group (a) opens a link and needs no handler. Group (b) acts, and each needs the founder's approval and Full depth.

### (a) URL buttons: no handler

| Button | Used by | Target |
|---|---|---|
| Open PR | 7, 8, 9, 10, 14 | the PR's `url` |
| Open CI run | 12, 14, 15 | the failing check's `detailsUrl` (add `statusCheckRollup` detail to the digest query) |
| Open session | 1, 3, 5 | the Claude app session link. **NOT VERIFIED:** no stable deep link was found for a background session. |

Group (a) is a `reply_markup` with `url` buttons. It works with `claude-notify` once it can send `reply_markup`. Build it first.

### (b) Action buttons: need a callback handler, founder approval, Full depth

All of these act on the founder's behalf, so each one follows the rule from `AGENTS.md`: a DB approval row first (`src/infra/hitl.ts`), the side effect only after a second tap, a founder-only check, and an audit row on real success.

| Button | Used by | Action | Why it is Full |
|---|---|---|---|
| Continue run | 1, 3 | sends `continue` to the paused session (`claude --bg --resume`) | spends usage and resumes an agent |
| Merge promotion | 9, 10 | merges the promotion PR with `--merge` | merges to the integration branch |
| Mark founder-action done | 9, 14 | ticks the item in the founder-action list | changes the founder's ledger |
| Retry start | 5 | runs the routine once more by hand | starts an agent |

Design rules for group (b):

1. Telegram callback data is 64 bytes. Put a short id in the button and keep the action and PR number in a DB row.
2. Route with a new prefix, `rt:`, in `src/jobs/bot.ts` next to `handleJobCallback`. Keep `jh:` as is.
3. First tap writes a pending row and asks "Confirm: merge PR N? [Yes] [No]". Only the second tap acts. Expire pending rows after 30 minutes.
4. Check `ctx.from.id` against the founder's id on every tap, not only the chat.
5. Write an audit row only after the action succeeds.

## Build order (for a later Sonnet session, once T1 lands)

1. **Land T1 first.** The scripts must be in git before any edit. Do not touch the VPS copies directly.
2. **Add `--html` and `--buttons <file>` to `claude-notify`.** Keep plain text as the default. Split long HTML only at line breaks and attach buttons only to the last part (the same pattern as `jobhunt-callbacks.ts:102`). Unit-test the splitter and the escaper.
3. **Convert the 15 templates** to HTML builders with escaping, one builder per row above. Test each against its example.
4. **Ship group (a) URL buttons.** Lite. One live message to the founder to check rendering.
5. **Build the `rt:` handler for group (b).** Full depth: approval rows, founder id check, idempotency, audit. Test the 64-byte limit. Then one live tap, with the output shown. Ship one action at a time, starting with "Mark founder-action done", then "Continue run", then "Merge promotion" last.

## NOT VERIFIED

- The contents of the job reports (rows 8 and 9) were not read in full. Only the report rules and the prompt headers were read. The `agent-jobs` folder is readable only as `claude-agent`.
- Counts for messages that are not logged (rows 1, 3, 5, 6, 12, 13, 15) are unknown. Only the journal lines that exist were counted.
- The verdict frequency gap (5 lines against one per group per day) is unexplained.
- The Telegram rendering of the examples was not tested. No test message was sent to the founder.
- No stable deep link to a background Claude session was found.
- No Telegram callback was tested live. The routing claim is from reading `src/jobs/bot.ts`.
