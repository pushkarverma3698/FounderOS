"""The browser queue: one job on screen, pre-filled, waiting for your decision.

THE MACHINE NEVER SUBMITS UNATTENDED (ADR-018). It fills the fields it can
verify from the profile, leaves everything else blank, and stops. The click that
presses the employer's real submit button is the founder's, and it is the same
click that records the application — so the ledger cannot drift from reality in
either direction.

The prototype this replaces looked identical and did neither: the real submit
call was commented out, so its big green button recorded an application that was
never sent. Every job it "applied" to was still open, and the ledger said
otherwise.
"""

from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from playwright.async_api import async_playwright

from . import ledger
from .adapters import ats_for_url, field_map_for, planned_fills
from .profile import ApplyProfile, load_profile, missing_resumes
from .sync import QueueJob, SyncError, QUEUE_DIR, load_queue, push_outcomes

#: Per-field fill timeout. Short: a selector that is not on this page should
#: cost a moment, not ten seconds times four fields times twenty jobs.
FILL_TIMEOUT_MS = 4000

#: Pages are recycled periodically — single-page-app job boards leak memory
#: across dozens of navigations, and a 20-job session is well inside that.
PAGE_RECYCLE_EVERY = 25

OVERLAY_JS = Path(__file__).resolve().parent / "overlay.js"


from .resolver import resolve_fallback_fields

async def fill_form(page, job: QueueJob, profile: ApplyProfile) -> tuple[list[str], list[str]]:
    """Fill what we can. Returns (filled labels, skipped labels)."""
    field_map = field_map_for(job.url)

    filled: list[str] = []
    skipped: list[str] = []

    try:
        await page.wait_for_selector('#first_name, #name, input[type="email"], input[type="file"]', timeout=10000)
    except Exception:
        pass

    if field_map is None:
        # An unrecognised ATS gets zero automation, not a best-effort guess —
        # the heuristic resolver below is for filling GAPS in a map we already
        # trust, not for deciding on its own that an unknown form is safe to
        # touch.
        return [], ["this ATS is not one we know — every field is yours"]

    plan = planned_fills(field_map, profile)
    resume_selectors = field_map.resume

    fallback_plan, fallback_resume = await resolve_fallback_fields(page, profile, plan)
    plan.extend(fallback_plan)
    if fallback_resume and not resume_selectors:
        resume_selectors = (fallback_resume,)

    for label, selectors, value in plan:
        if not value.strip():
            skipped.append(f"{label} (not in your profile)")
            continue
        if await _fill_first(page, selectors, value):
            filled.append(label)
        else:
            skipped.append(f"{label} (no matching field on this form)")

    resume = profile.resume_for(job.track, job.id)
    if resume and resume_selectors and await _upload_first(page, resume_selectors, resume):
        filled.append(f"resume ({Path(resume).name})")
    else:
        skipped.append("resume (no upload field found)")

    return filled, skipped


async def _fill_first(page, selectors: tuple[str, ...], value: str) -> bool:
    """Fill the first selector that exists via native keystrokes. False when none do."""
    for selector in selectors:
        try:
            loc = page.locator(selector).first
            await loc.wait_for(state="visible", timeout=2000)
            await loc.scroll_into_view_if_needed()
            await loc.focus()
            await page.keyboard.press("Meta+A")
            await page.keyboard.type(value, delay=15)
            print(f"  [TYPE OK] {selector} -> {value}", flush=True)
            return True
        except Exception as err:
            print(f"  [TYPE FAIL] {selector}: {err}", flush=True)
            continue
    return False


async def _upload_first(page, selectors: tuple[str, ...], path: str) -> bool:
    for selector in selectors:
        try:
            loc = page.locator(selector).first
            await loc.wait_for(state="attached", timeout=2000)
            await loc.set_input_files(
                str(Path(path).expanduser()), timeout=FILL_TIMEOUT_MS
            )
            print(f"  [UPLOAD OK] {selector} -> {path}")
            return True
        except Exception as err:
            print(f"  [UPLOAD FAIL] {selector}: {err}")
            continue
    return False


def copy_to_clipboard(text: str) -> bool:
    """Best-effort, macOS only (pbcopy) — this client only runs on the
    founder's Mac. Never raises: a clipboard failure must not stop the job
    from opening, only cost the founder one manual copy.
    """
    try:
        subprocess.run(["pbcopy"], input=text.encode(), timeout=5, check=True)
        return True
    except Exception:
        return False


from .liveness import classify_response


def ashby_application_url(url: str) -> str:
    """Ashby's posting URL renders an overview page with NO application
    fields at all — the real form lives on a separate `/application` route
    (a distinct tab href, not a same-page reveal). Found live, 2026-08-25:
    every fill attempt against a real Ashby posting (Altura) timed out
    waiting for selectors that were correct — `_systemfield_name` etc. really
    are Ashby's field names — because the page loaded here never had any
    `<input>` on it. Same root cause and same fix as the VPS TypeScript
    pipeline's `ashbyApplicationUrl` in apply-driver.ts (2026-08-24/25); this
    is a separate Python implementation that never got the port.
    """
    parts = urlsplit(url)
    path = parts.path.rstrip("/")
    if not path.endswith("/application"):
        path = f"{path}/application"
    return urlunsplit((parts.scheme, parts.netloc, path, parts.query, parts.fragment))


async def process_job(page, job: QueueJob, profile: ApplyProfile, position: str) -> str:
    """Open one job, fill it, and wait for the founder. Returns the outcome."""
    is_ashby = ats_for_url(job.url) == "ashby"
    target_url = ashby_application_url(job.url) if is_ashby else job.url
    response = await page.goto(target_url, wait_until="domcontentloaded")

    if is_ashby:
        # `domcontentloaded` fires before Ashby's React app hydrates the
        # form — same race already documented on the TS side. Wait for a
        # stable system-field id rather than a fixed sleep; if it never
        # appears, fill_form still runs and honestly reports what it finds.
        try:
            await page.locator('[name="_systemfield_name"]').first.wait_for(state="visible", timeout=8000)
        except Exception:
            pass

    if response:
        redirected = response.request.redirected_from is not None
        liveness = classify_response(response.status, job.url, page.url, redirected)
        if liveness == "expired":
            print(f"  [SKIPPED] Posting no longer available (caught at open).")
            ledger.record(job.id, ledger.SKIPPED, company=job.company, title=job.title)
            return ledger.SKIPPED

    filled, skipped = await fill_form(page, job, profile)

    try:
        await page.locator('input[type="file"], #first_name, #name, input[name="email"]').first.scroll_into_view_if_needed(timeout=2000)
    except Exception:
        pass

    loop = asyncio.get_running_loop()
    decided: asyncio.Future[str] = loop.create_future()

    async def on_decision(_source, outcome: str) -> None:
        # Recorded HERE, in the same handler the founder's click reaches, and
        # flushed to disk before the queue advances. Recording later — after the
        # navigation, at session end — is how a crash loses an application that
        # really was submitted.
        ledger.record(job.id, outcome, company=job.company, title=job.title)
        if not decided.done():
            decided.set_result(outcome)

    try:
        await page.expose_binding("founderosDecision", on_decision)
    except Exception:
        # expose_binding is per-page and raises if the name is already bound,
        # which is the normal case on a recycled page.
        pass

    cover_letter_path = QUEUE_DIR / job.id / "cover_letter.txt"
    cover_letter_copied = False
    if cover_letter_path.is_file():
        try:
            cover_letter_copied = copy_to_clipboard(cover_letter_path.read_text(encoding="utf-8"))
        except OSError:
            cover_letter_copied = False

    await page.evaluate(
        OVERLAY_JS.read_text(),
        {
            "position": position,
            "company": job.company,
            "title": job.title,
            "filled": filled,
            "skipped": skipped,
            "cover_letter_copied": cover_letter_copied,
        },
    )

    return await decided


async def run_queue(jobs: list[QueueJob], profile: ApplyProfile) -> dict[str, int]:
    """Walk the queue. One job on screen at a time, in rank order."""
    tally = {ledger.APPLIED: 0, ledger.SKIPPED: 0, "error": 0}

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        context = await browser.new_context(accept_downloads=False)
        page = await context.new_page()

        for index, job in enumerate(jobs, start=1):
            position = f"{index} of {len(jobs)}"
            if page.is_closed() or index % PAGE_RECYCLE_EVERY == 0:
                if not page.is_closed():
                    await page.close()
                page = await context.new_page()

            try:
                outcome = await process_job(page, job, profile, position)
                tally[outcome] += 1
                print(f"[{position}] {outcome}: {job.company} — {job.title}")
            except Exception as err:
                # One broken posting must not end the session. The founder keeps
                # the rest of his queue, and the row stays unhandled so it is
                # offered again rather than silently lost.
                tally["error"] += 1
                print(f"[{position}] skipped after an error ({err}): {job.company}")

        await browser.close()
    return tally


def flush_outcomes() -> int:
    """Push the local ledger to Postgres and clear it only once confirmed."""
    entries = ledger.pending()
    if not entries:
        return 0
    applied, skipped = ledger.split_pending(entries)
    changed = push_outcomes(applied, skipped)
    ledger.clear()
    return changed


def main() -> int:
    try:
        profile = load_profile()
        jobs = load_queue()
    except (SyncError, RuntimeError) as err:
        print(f"✗ {err}")
        return 1

    # Anything already on disk goes back first: a previous session may have
    # ended in a crash, and those applications are real.
    try:
        recovered = flush_outcomes()
        if recovered:
            print(f"↻ pushed {recovered} outcome(s) from a previous session")
    except SyncError as err:
        print(f"⚠ could not push previous outcomes ({err}) — they are kept locally")

    if not jobs:
        print("Nothing in the queue. The sweep has not found anything unapplied.")
        return 0

    problems = missing_resumes(profile, jobs)
    if problems:
        # One job missing a resume must not block every other job in the
        # queue — refusing to start over a single row was the old behaviour,
        # and it cost a whole day's queue for one bad row. Skip only the rows
        # that are actually missing a resume; they are reported, not silently
        # dropped, and come back once the resume is on disk.
        print("⚠ The following jobs are missing required resumes and will be skipped:")
        for problem in problems:
            print(f"    {problem}")

        jobs = [job for job in jobs if not missing_resumes(profile, [job])]

        if not jobs:
            print("✗ No jobs left in the queue with valid resumes. Refusing to start.")
            return 1

    print(f"{len(jobs)} job(s) queued. The browser will open one at a time.")
    tally = asyncio.run(run_queue(jobs, profile))

    try:
        changed = flush_outcomes()
        print(f"✓ {tally[ledger.APPLIED]} applied, {tally[ledger.SKIPPED]} skipped "
              f"({changed} recorded on the VPS)")
    except SyncError as err:
        print(f"⚠ {tally[ledger.APPLIED]} applied, but the VPS push failed ({err}).\n"
              "  They are on disk and will be pushed on the next run.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
