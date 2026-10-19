# 2026-10-19 — Mini App apply + answers editor: build and live QA

## What we did
Built the Telegram Mini App so the founder applies from one form instead of chat back-and-forth, and edits saved
answers from a second form. Plan: `~/.claude/plans/parsed-skipping-fox.md`. Sonnet builders, Claude reviewed each PR
against its diff and ran every live test through a real Telegram-signed Mini App URL (`scripts/telegram-webapp.ts`)
in the built-in browser at phone width.

| PR | What |
|---|---|
| #1210 | Submit + Cancel on the answer page, initData auth, persisted double-submit guard, `action_log` row, ADR-018 |
| #1209 | Atomic answer store, backups, restore, Core Facts kept in step with `answers.*` |
| #1208 | `scripts/telegram-webapp.ts`: MTProto `requestWebView` → real signed Mini App URL |
| #1211/#1212 | Job list home (`/apply/home`, menu button) and the saved-answers editor (`/apply/profile`) |
| #1214 | Greenhouse email-code step: page held 10 min, code box on the form |
| #1216 | Sweep fixes: ask rows ("Needs your call"), filter, Submit copy, notice hint, company-named answers not saved globally, `menu` peer |
| #1217 | Ashby nameless Location combobox filled, Submit blocked while a `*` field is empty, unconfirmed evidence on the page |
| #1219 | Form-only answers (company-named) reach the submit run |
| this PR | Unconfirmed result on a reCAPTCHA page says the bot check most likely refused it, and to submit by hand |

## Live results (prod, founder profile `pushkar-nl-tech`)

### PASS
- Home list loads for the founder; a non-UUID or the wife's row (0c6d6115) returns 404 on job-status and prepare.
- Telnyx stale snapshot opens straight into its answer page (18/18 filled).
- Profile editor: loads core, EEO, 21 learned answers, Core Facts, backups. Save notice=30 → 200, JSON written, backup made. Restore → files byte-identical to the pre-test backup (sha256 checked). Stale `baseVersion` → 409. No auth / tampered hash → 404. Non-number salary → 400. Non-editable field → 400. Path-traversal backupId → 400. Deleting a missing answer → 200 `changed:false`.
- Mollie prepare from the Mini App API → 202, then `blocked` with the open question named; answering it on the page and saving re-filled in place (12/12, MainButton "Submit application" appeared without a reload); MainButton → confirm step ("Yes, submit" / "Back") → submit accepted.
- After #1217: Location filled from the profile ("Mohali, Punjab, India"); every starred field filled (post-submit screenshot).
- After #1217: the unconfirmed reason shows on the page ("What the bot saw: …"), not only in chat.
- Unconfirmed submit is handled safely: row stays `screened`, no `applied_at`, chat gets the screenshot and the reason.
- Deleted the mis-saved global answer "How did you hear about us? → Mollie's Career Site" via the editor's `deleteLearned`: gone from both files, backup `2026-10-19T06-41-03-651Z`.

### FAIL → fixed or in flight
- 215 `ask` rows (Mollie among them) were missing from the list → #1216.
- No filter on a 116-row list → #1216.
- Answer page said "press Submit in Telegram" → #1216.
- Notice days had no effect while the detail is set, no hint → #1216 (hint).
- A company-named learned answer was saved for every form → #1216.
- **Mollie real Submit sent nothing**: Ashby's required Location field is `<input role=combobox>` with no name, no id and no `required` attribute; `form-scraper.ts` drops inputs without name/id, so the page said 12/12 and Ashby refused the click silently. Root cause confirmed in the live DOM. Fix: builder H (`fix/ashby-nameless-combobox`), which also blocks Submit when a `*` field is empty and puts the real evidence on the page's unconfirmed status (today it is only in chat).
- **Mollie submit after #1217/#1219 (prod 2282a96d): unconfirmed again.** Every field filled, no error, no thank-you, no URL change.
  The page loads reCAPTCHA Enterprise (invisible, `recaptcha/enterprise.js` + `.grecaptcha-badge`). A headless browser on a
  datacenter VPS is the low-score case, so Ashby most likely refused it silently. HYPOTHESIS: Ashby returns no visible error,
  so this is inferred, not observed. We do not try to get past bot checks. Fix in this PR: the result says so and tells the
  founder to submit from the job link. Row stays `screened`, `applied_at` null.
- Gap: an unconfirmed job opened from the home list shows the old snapshot with no "prepare again" button; the page points to /apply in chat.
- The filler did not map the saved `authorized-no-sponsorship` onto Ashby's "Not Applicable" option; answered by hand on the page.

### NOT VERIFIED
- Greenhouse code step end to end: needs the founder at his inbox to type the code (we never read Gmail; Gmail tokens are also revoked).
- One Lever submit.
- The founder's own apply from his phone.

## Metrics
- Real applications sent from the Mini App this session: 0. Mollie: first the Location bug, then (most likely) Ashby's invisible reCAPTCHA.

## Verdict
The Mini App works as a form: list, prepare, answer, save, submit, cancel and the answers editor all passed live. It is NOT a
reliable way to send applications yet: of the ATSs tried, Ashby (reCAPTCHA Enterprise) and AppZen (visible CAPTCHA) refuse the
VPS browser, and Greenhouse needs the founder's emailed code. Use it to prepare and check answers; expect to press Submit
yourself on reCAPTCHA sites.

## Outstanding
See the end of the session reply.
