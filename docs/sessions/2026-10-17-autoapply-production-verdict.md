# /apply production verdict: 2026-10-17/18

**Ready for regular phone use: NO.** 2 of 5 real Submits reached the employer. Two more stopped at a CAPTCHA,
and one stopped at Greenhouse's emailed code. The bot's own record is right for only 1 of the 2 sends.

Prod during the run: 4f8c6c66, then 9f444059 (#1204: #1200–#1203), then d95d8a8a (#1206: #1205 permit-sentence fix).
Driven as the founder from `scripts/telegram-tap.ts` on the VPS (`/opt/review/founderos-applyprod`), with every Submit
authorised by the founder in chat.

## Results

| Job (ATS) | Outcome | Proof |
|---|---|---|
| Matillion (Lever) | **Sent, confirmed** | bot "✅ Application submitted"; DB `stage=applied`, `applied_at 2026-10-17 17:29:27Z` |
| Bureau (Ashby) | **Sent, but the bot says unconfirmed** | post-submit screenshot shows Ashby's green "Success" banner; DB still `screened` |
| EMA (Ashby) | Not sent: hCaptcha | post-submit screenshot shows an image challenge over the form; DB `screened` |
| AppZen (Lever) | Not sent: hCaptcha | post-submit screenshot shows an image challenge; 7 essay answers were filled; DB `screened` |
| Telnyx (Greenhouse) | Not sent: emailed security code | no in-bot code step in prod (the Greenhouse session has no PR) |

Not attempted to Submit: NETGEAR (Ashby, "no fillable form fields"), Dash0 / i3D.net (Ashby, essays + Go + residency),
Everbridge (Lever, 12 unanswered), Keywords Studios (Workable, 9 required fields unmapped). `agents.action_log` got
**0 rows** for every Submit.

## What the founder does per application today

- `/apply j…`, then answers 1–7 questions by typing. Matillion: 5 taps; Bureau: 2 typed answers + Submit. Bot steps
  take about 30–60 s each, so roughly 3–5 min per job when nothing breaks.
- Every CAPTCHA'd or unconfirmed send: opens the screenshot and decides. That is 3 of 4 non-Greenhouse Submits here.
- Every Greenhouse job: blocked until the code step ships.
- Nearly every real posting asks free-text essays, so he writes or approves text on most applications.

## Defects (each with a one-line fix)

1. **CAPTCHA is reported as "could not confirm"** (EMA, AppZen). Fix: detect an hCaptcha/reCAPTCHA iframe after the click, say "CAPTCHA: finish on the company page" and hand over the link.
2. **Ashby success not detected** (Bureau): the banner "Success / Thanks for throwing your hat in the ring" was missed. Fix: match Ashby's success alert (`role=alert` containing "Success") in the confirmation check.
3. **No `action_log` row and no idempotency key on Submit** (`src/gateway/auto-apply.ts` confirmed branch). Fix: write the audit row keyed by row id after `markRowApplied`, and check `hasBeenAudited` before clicking.
4. **One apply session per chat** (`sessionsByChat`, `apply-session.ts:99`): a second `/apply` takes over typed answers for the first, and the "Reply to this message" prompt ignores reply-to. Fix: route typed answers by `reply_to_message` id first, then by the chat's latest session.
5. **Yes/No radios render as one "YesNo" button** (Dash0, i3D, Mollie). Fix: split options per radio input label.
6. **Cover letter returns 0 chars** (Matillion, Bureau twice), with no retry. Fix: one retry, then fall back to the /draft letter.
7. **Cover letters state unchecked facts** (an IND permit claim, "80 actions per day"; the CV says 80 total). #1205 removes the permit sentence; fix the rest by validating letter numbers against the CV.
8. **Label mapping misses**: phone, "First name", years-of-experience bucket, "Current/Expected CTC". Fix: add synonyms to the standard-answer map.
9. **The dossier holds contradicting learned answers** ("based in NL: Yes" vs "zoekar visa", veteran "No" vs "decline", "Go in production: Yes" with no Go on the CV). Fix: replace on conflict instead of appending (#1202 started this).
10. **Tester guard broke with the #1200 callback nonce**: `TAP_ALLOW_SUBMIT_ROWS=<rowId>` no longer matches `jh:s:<row>:<nonce>`. Fix: match on the row-id prefix in `scripts/lib/tap-guard.ts`.
11. A scheduled "112 jobs ready" or funnel alert lands mid-question flow. Fix: hold digests while an apply session is open.

## NOT VERIFIED

- Confirmation emails for Matillion and Bureau: the Gmail tokens are revoked (`gmail_search` returned re-authorization errors).
- Bureau's DB row was left as `screened`; I did not hand-edit prod data.
- No Workable or Greenhouse send.
