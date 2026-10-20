# 2026-10-19 — Mini App: Submit it yourself + Prepare again

## What we did
- #1223: "Submit it yourself" section on the answer page: the job link (`Telegram.WebApp.openLink`), a Copy button per filled answer, and "I submitted it" with a confirm step. It marks the row applied and writes an audit row; initData auth is required.
- #1224: "Prepare again" button for unconfirmed, stale or cancelled rows. It calls `POST /apply/api/prepare/<id>`, then polls job-status and opens the fresh form.
- #1225: Submit it yourself shows on every unconfirmed row. Before this it showed only when the evidence named a bot check, and Mollie's evidence predates that wording. The intro now says "check your email first" unless a bot check was named.
- #1228: Prepare again appears as soon as Cancel succeeds. Before this it stayed hidden because polling had already stopped.
- Promotions: #1226 (b2c47e13) and #1229 (db8d0b4b); #1230 (4ea886e9) carried #1228 again together with #1227.

## What we fixed
- Mollie (ebdf4da4, unconfirmed after the bot clicked Submit): no self-submit path was shown. Fixed by #1225.
- Cancel left no way to try again. Fixed by #1228.

## Why
Ashby's invisible reCAPTCHA refuses the VPS browser, and the bot never tries to get past bot checks. The founder needs to finish the application himself from the same screen.

## Metrics (live on prod, browser pane at 375x812)
- Mollie: the section renders with the job link, 11 Copy buttons and I submitted it. A real Copy click wrote to the clipboard. The confirm and Back both work. Yes was never tapped, because only the founder knows whether he sent it.
- Telnyx (4b713482):
  - Home → prepare → form.
  - Cancel shows "Cancelled. Tap Prepare again for a fresh form." and the button appears.
  - Prepare again returns 202 and opens a fresh signed form link (new expiry). Runs on 4ea886e9.

## Outstanding
- NOT VERIFIED: the "Yes, I submitted it" tap on prod (only the founder can make it), and `tg.openLink` inside native Telegram.
- Two Deploy runs fire per main merge; each restarts the service and kills any in-flight prepare (seen twice today, both times as a 502).
- After a failed job-status poll the answer page shows "Could not read the status" with no retry button. The founder has to reopen from home, and the old link is then closed.
- Prepare takes about 4 minutes when 6 required fields are unanswered: each one waits through a 5s fill timeout plus retries (~36s per field).
