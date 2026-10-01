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

If the site's form sends you to another page when you press SUBMIT & NEXT (a plain
form that posts and shows a thank-you page), the bar is rebuilt on that page and asks
the same question, **Did the application go through?** Only your **YES** records it:
the page saying "Thank you" is not enough, because the page it would be compared with
is gone. **NO** records nothing, gives you the buttons back and prints one
`[NOT RECORDED]` line in the terminal. If the new page never finishes loading (30
seconds), nothing is recorded, the same kind of line is printed and the queue moves on;
the row comes back in your next queue, so check the site before you apply again.

A page change *before* you press SUBMIT & NEXT (a link, a second step) removes the bar
and does not bring it back. Stop the run with Ctrl-C and start it again: what you
already recorded is on disk and is pushed at the next start.

SUBMIT & NEXT presses the form's real submit control; when there is none it looks for
a button by its words: *Submit*, *Submit application*, *Apply now*, *Send application*,
and in Dutch *Verzenden*, *Versturen*, *Verstuur*, *Sollicitatie versturen*,
*Sollicitatie verzenden*, *Verstuur sollicitatie* (the whole label, so "Verstuur naar een
vriend" is not pressed). It never presses *Solliciteer* / *Solliciteren*: that button
opens the form.

If the bar cannot find the site's submit button, submit the form yourself, then
press **I SUBMITTED IT MYSELF** to record it. (If your own submit replaces the page, the
bar comes back on the new page with the same **Did the application go through?** question:
**YES** records it.) **SKIP** removes the row from your
list for good: it does not come back tomorrow.

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
| `mac_client/after_submit.py` | a submit that navigates: asks you on the new page, never records by itself |
| `tools/capture_apply_form.py` | dev tool: saves one apply page's DOM and controls, read-only (see below) |

## Capture a real apply form (dev tool, read-only)

**This tool has NEVER been run against SmartRecruiters**, or against any real site. It was
tested only on a local page with an open shadow root, because the machine it was built on
cannot reach the real page. The first real run may need a fix: send what it printed.

Why it exists: a field map for a platform nobody has seen (SmartRecruiters) has to be written
from the real page, not guessed. This saves what the page looks like and touches nothing on it.
Run it on the Mac (its browser trusts your network), on a posting's apply page:

```bash
cd mac-client
.venv/bin/python tools/capture_apply_form.py "https://jobs.smartrecruiters.com/<company>/<posting>" \
    --locale nl-NL --out captures/smartrecruiters-nl
```

It opens a fresh browser (no login, no cookies), loads that ONE address, waits up to 20 s for form
fields (`--wait 40` for a slow page, `--headed` to watch), and writes three files next to `--out`:

| File | What is in it |
|---|---|
| `.dom.html` | the page as rendered, open shadow roots written out in place; scripts, styles, images, iframes, links and form targets removed; hidden fields keep their name and lose their value |
| `.controls.json` | every input, textarea, select, button and custom element, with its attributes, its label and whether it is visible |
| `.meta.json` | final address, status, redirects, title, language, what was clicked, and how many iframes and unreadable custom elements it could not see |

It never types, selects, uploads or submits. It clicks nothing unless you give it
`--click "<the button's whole text>"` (repeatable) to open a form that is hidden behind a button,
and then it presses only that one button or link, and only if exactly one matches. It refuses,
before it even starts, any text that looks like sending an application (submit, verzenden,
versturen, send application, apply now, solliciteer), and at the page it refuses any control that
would submit a form whatever its label says. If the button that opens the form is called
"Solliciteer nu" or "Apply now", open the form in your own browser and give the tool the form's own
address instead.

Exit codes: `0` captured; `1` the page would not load; `2` a click was refused; `3` captured, but no
form field ever appeared (the form may be behind a button, inside an iframe, or the site refused this
browser: try `--headed`). A certificate error is explained and never bypassed: use a machine and
network whose browser trusts it.

The files go to `captures/` by default, which git ignores. They are somebody else's page: skim them,
then send the three files for the field map. Nothing is uploaded by the tool.

Full pipeline documentation (screening, ranking, tailoring, cost tracking,
known gaps): [`docs/JOBHUNT.md`](../docs/JOBHUNT.md).
