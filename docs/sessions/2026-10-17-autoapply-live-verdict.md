# 2026-10-17 — Telegram auto-apply: live verdict

Follows `2026-10-16-ats-autoapply-qa-handoff.md`. Prod `8c8c4829` (promotion #1188 carried #1185, #1187, #1184, #1186).

## Verdict

Updated after the real-Submit run below. Telegram drives the whole flow up to 🚀 Submit: fill, CV, cover letter,
questions, answer page. No application has been sent end to end yet. Greenhouse, where most of the queue sits,
asks for an emailed human-verification code after Submit, and the bot cannot enter it. Not ready for unattended
daily use. Workday is unsupported.

The first verdict, written before anyone pressed Submit: ready up to the 🚀 Submit button, with Submit NOT VERIFIED.

## Real-Submit run (later on 10-17)

The founder authorised real applications to three jobs on three ATSs. A subagent drove Telegram as the founder
(MTProto, one script at a time). Prod `2a3130f2` carried #1192 (cover letter on /apply and Submit) and #1194 (send once).

| Row | ATS | Card | Outcome |
|---|---|---|---|
| Telnyx `j4b71348` | Greenhouse | 17/18 → 18/18 after one tap (Veteran Status: decline) | Submit clicked. Greenhouse then emailed an 8-character code "to confirm you're a human"; Submit stays greyed until it is typed. Bot said "⚠ Could not confirm submission". Not sent. |
| EMA `j5b1a4ab` | Ashby | 6/8 → 7/8 after an answer-page save | Required "Current Base Salary" has no source (only an expectation). Not submitted. |
| AppZen `j339cbd6` | Lever | 9/16, 7 required | Seven required free-text ML/LLM experience questions with no source. Not submitted. |

Postgres afterwards: all three `screened`, `applied_at` null. Gmail could not be checked: both Google tokens are revoked (`invalid_grant`).

What worked through Telegram: the CV on all three (answer page "CV attached"), the cover letter on Telnyx (file field
attached, not asked as text), option answers saved to the dossier, Cancel and re-`/apply` (~30 s), and an answer-page
save that re-filled the form and posted a fresh card.

Defects found:
- Double tap on Submit. grammY polling handles updates one at a time, so the second tap ran after the first send ended
  unconfirmed and passed #1194's lock. Only Telegram's 30 s tap expiry stopped it. Fixed in #1198.
- Stale cards keep live buttons after a newer card arrives.
- A model 429 on the cover letter shows the raw provider error in the card, with no retry.
- An answer-page save posts no 💾 line in Telegram.
- Greenhouse's code step is reported as a generic "could not confirm", not as "type the code from your email".

## What we did

Drove `/apply j4b713482` (Greenhouse, Telnyx) on prod through Telegram with `scripts/telegram-tap.ts` (MTProto, as the
founder; the script refuses `jh:s:`). Opened the hosted answer page at phone width in a browser. Never pressed Submit.

| Step | Channel | Result |
|---|---|---|
| `/apply j4b713482` | Telegram | Card "Filled 16/18 · 2 unanswered (0 required)", answer-page button first, then "✅ Form ready" with Submit |
| Skip "Cover Letter" | Telegram button `jh:q:<row>:skip` | Toast "Skipped question", question 2/2 sent with 3 option buttons |
| Type the Veteran Status answer | Telegram text | "💾 Saved", re-fill, card 17/18, "✅ Form ready", no re-ask |
| Open the link | Public HTTPS (Tailscale Funnel) | 200, prefilled: 17 rows under "Already filled", file field read-only |
| Change one radio, Save | Answer page POST | "Saved 1 answer" (unchanged values skipped), fresh card 17/18 in Telegram; new link shows the new value |
| Tampered signature / tampered expiry | Public HTTPS | 404 / 404 |
| JSON POST | Public HTTPS | 415 |
| Cancel `jh:k:` | Telegram button | "Cancelled", snapshot file deleted, genuine link now 404 |
| Row state | Postgres `agents.job_applications` | `applied_at` null, `skipped_at` null |

Test answers were reverted afterwards: `apply-profile.json` and `candidate-dossier.md` sha256 match the pre-test backup.

## What we fixed (this cycle, all merged)

- #1185: the question loop (saved answers lose to the standard mapping), the false "filled" check on comboboxes
  (read before blur), and Enter firing form-wide validation.
- #1187: hosted answer page. The Telegram card links our prefilled page, not the blank company page.
- #1184: the `/apply` route is published on public HTTPS through Tailscale Funnel. Only `/apply` is exposed.
- #1186: `scripts/telegram-tap.ts`, which presses inline buttons as the founder and never presses Submit.

## Why

The founder reported "stuck, hallucinated, blank form". The causes were the loop, the false "filled" check, and the
"Open form" button that linked the blank company page.

## Outstanding

- Fixed in #1190: Telegram asked a file field ("Cover Letter") as a text question. It now posts a 📎 notice.
- NOT VERIFIED: a real Submit (ATS accepts, row marked applied). The run above reached Submit three times and sent
  nothing. Next tries: a Greenhouse row with the founder typing the emailed code, or an Ashby/Lever row whose
  required questions all have a source. Substitute rows need the founder's yes.
- Founder decisions: EMA's current base salary, AppZen's seven experience answers, and whether Greenhouse
  applications are finished by hand.
- NOT VERIFIED live: the 410 page for an expired link. Unit-tested only.
- Pre-existing and low risk: Submit does not re-check readiness, and "Form ready" does not mention a CAPTCHA.
  Both fail loudly, because Submit re-fills from scratch and marks a row applied only when the ATS confirms.
