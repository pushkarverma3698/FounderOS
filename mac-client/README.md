# FounderOS Mac apply client

The last mile: the VPS finds and screens the jobs, this opens each one with the
form already filled and waits for you to decide.

**The machine never submits unattended, and never records `applied` without confirming it** (ADR-018). It fills what it can
verify, leaves everything else blank, and advances only when you click.

## Install (once)

```bash
cd mac-client
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/playwright install chromium
cp apply-profile.example.json apply-profile.json   # then fill it in
./install-launchagent.sh
```

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

`applied` is recorded from exactly two things: a positive sign from the page
(it says "Thank you, application received", the form disappears, or the address
changes), or your own **YES**. If the page says nothing either way, the bar asks
**Did the application go through?** and writes nothing until you answer: **YES**
records it, **NO** records nothing and gives you the buttons back.

Before you submit, the overlay tells you which resume is attached — read this,
it is not decorative:

| Label | Meaning |
|---|---|
| 🟢 Tailored CV attached | a CV built for this specific role |
| 🟡 Generic CV — no tailored one yet | you haven't run `/draft` on this row |
| 🔴 Tailored CV FAILED to download | one exists but the fetch from S3 broke |

A tailored CV is not automatically verified true — read it before you submit.
See `docs/JOBHUNT.md` ("Known limitation: CV fabrication risk") for why.

## Files

| File | Job |
|---|---|
| `mac_client/wake.py` | login/wake trigger — sync + one Telegram message, no browser |
| `mac_client/sync.py` | pull the ranked queue + CVs from the VPS over SSH |
| `mac_client/notify.py` | one-shot Telegram POST — no polling, no bot conflict |
| `mac_client/profile.py` | load/validate `apply-profile.json`; the tailored-vs-generic CV signal |
| `mac_client/adapters.py` | per-ATS form field maps (Greenhouse, Lever, Ashby, Workable, Recruitee) and where each platform's application form lives (`apply_url_for`, shared cases in `tests/fixtures/apply-url-cases.json`) |
| `mac_client/resolver.py` | heuristic DOM fallback that fills gaps in a field map, reading English and Dutch labels; never a cover letter |
| `mac_client/apply.py` | the browser queue and the overlay |
| `mac_client/ledger.py` | crash-safe local record + flow-back to Postgres |

Full pipeline documentation (screening, ranking, tailoring, cost tracking,
known gaps): [`docs/JOBHUNT.md`](../docs/JOBHUNT.md).
