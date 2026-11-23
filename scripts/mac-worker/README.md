# Mac worker

Applies to CAPTCHA-blocked forms from your own Chrome, over the VPS `/apply/mac-worker/` API (issue #1324).
It leases a row, fills the form, and submits only when the auto-send rules pass and no bot check is on screen.
A visible check is reported to Telegram and the tab waits up to 30 minutes for you to click it.

## Setup

1. `scripts/mac-worker/start-chrome.sh` starts a separate Chrome (own profile, debugging port 9222). Leave it open.
2. Set the token and the VPS address (token is `MAC_WORKER_TOKEN` on the VPS; never commit it):
   `export MAC_WORKER_TOKEN=... MAC_WORKER_URL=https://<vps-base-url>`
3. Dry run (default, fills but never clicks Submit): `node --import tsx/esm scripts/mac-worker.ts`
4. Real submits, only after the founder approves them: add `--live`.
5. Keep it running: copy `com.founderos.mac-worker.plist.template` to `~/Library/LaunchAgents/`, fill in the paths, token and URL.

A dry run releases each row with a `failed: dry run` note and uses one of its 3 lease attempts.
`mac-client/` stays until 5 confirmed sends.
