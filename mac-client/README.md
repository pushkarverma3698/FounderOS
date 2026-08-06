# FounderOS Mac apply client

The last mile: the VPS finds and screens the jobs, this opens each one with the
form already filled and waits for you to decide.

**The machine never submits an application** (ADR-009). It fills what it can
verify, leaves everything else blank, and advances only when you click.

## Install (once)

```bash
cd mac-client
python3.13 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/playwright install chromium
cp apply-profile.example.json apply-profile.json   # then fill it in
./install-launchagent.sh
```

**Python 3.13, not `python3`.** On a Mac where `python3` is 3.14, the install
fails building greenlet (a Playwright dependency) and you get a venv with no
Playwright in it — the queue then dies at import time, after the LaunchAgent has
already told you the jobs are ready.

`apply-profile.json` is gitignored and holds your name, email, phone and the
path to the resume PDF for each track. Nothing invents these values: a field
you leave out is a field left blank on the form for you to complete.

## Use

On login or wake the LaunchAgent syncs the queue and sends one Telegram message
("12 jobs ready"). The browser opens only when you say so:

```bash
cd mac-client && .venv/bin/python -m mac_client.apply
```

Each job: review the pre-filled form, complete anything it left blank, then
**SUBMIT & NEXT** (presses the site's own submit, records it, moves on) or
**SKIP** (records that you passed, moves on). Both are your click.

## Files

| File | Job |
|---|---|
| `mac_client/sync.py` | pull the ranked queue from the VPS over SSH |
| `mac_client/notify.py` | one Telegram message — no polling, no bot conflict |
| `mac_client/profile.py` | load and validate `apply-profile.json` |
| `mac_client/adapters.py` | per-ATS form field maps (Greenhouse, Lever, Ashby) |
| `mac_client/apply.py` | the browser queue and the overlay |
| `mac_client/ledger.py` | crash-safe local record + flow-back to Postgres |
