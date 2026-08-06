"""The browser queue: one job on screen, pre-filled, waiting for your decision.

THE MACHINE NEVER SUBMITS ON ITS OWN (ADR-009). It fills the fields it can
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
from pathlib import Path

from playwright.async_api import async_playwright

from . import ledger
from .adapters import field_map_for, planned_fills
from .profile import ApplyProfile, load_profile, missing_resumes
from .sync import QueueJob, SyncError, load_queue, push_outcomes

#: Per-field fill timeout. Short: a selector that is not on this page should
#: cost a moment, not ten seconds times four fields times twenty jobs.
FILL_TIMEOUT_MS = 4000

#: Pages are recycled periodically — single-page-app job boards leak memory
#: across dozens of navigations, and a 20-job session is well inside that.
PAGE_RECYCLE_EVERY = 25

OVERLAY_JS = Path(__file__).resolve().parent / "overlay.js"


async def fill_form(page, job: QueueJob, profile: ApplyProfile) -> tuple[list[str], list[str]]:
    """Fill what we can. Returns (filled labels, skipped labels).

    Both lists reach the overlay. A form that was silently half-completed is one
    the founder submits believing it was whole — so the badge says exactly which
    fields the tool touched and which it left for him.
    """
    field_map = field_map_for(job.url)
    if field_map is None:
        return [], ["this ATS is not one we know — every field is yours"]

    filled: list[str] = []
    skipped: list[str] = []

    for label, selectors, value in planned_fills(field_map, profile):
        if not value.strip():
            skipped.append(f"{label} (not in your profile)")
            continue
        if await _fill_first(page, selectors, value):
            filled.append(label)
        else:
            skipped.append(f"{label} (no matching field on this form)")

    resume = profile.resume_for(job.track)
    if resume and await _upload_first(page, field_map.resume, resume):
        filled.append(f"resume ({Path(resume).name})")
    else:
        skipped.append("resume (no upload field found)")

    return filled, skipped


async def _fill_first(page, selectors: tuple[str, ...], value: str) -> bool:
    """Fill the first selector that exists. False when none do."""
    for selector in selectors:
        try:
            await page.locator(selector).first.fill(value, timeout=FILL_TIMEOUT_MS)
            return True
        except Exception:
            continue
    return False


async def _upload_first(page, selectors: tuple[str, ...], path: str) -> bool:
    for selector in selectors:
        try:
            await page.locator(selector).first.set_input_files(
                str(Path(path).expanduser()), timeout=FILL_TIMEOUT_MS
            )
            return True
        except Exception:
            continue
    return False


async def process_job(page, job: QueueJob, profile: ApplyProfile, position: str) -> str:
    """Open one job, fill it, and wait for the founder. Returns the outcome."""
    await page.goto(job.url, wait_until="domcontentloaded")
    filled, skipped = await fill_form(page, job, profile)

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

    await page.evaluate(
        OVERLAY_JS.read_text(),
        {
            "position": position,
            "company": job.company,
            "title": job.title,
            "filled": filled,
            "skipped": skipped,
        },
    )

    return await decided


async def run_queue(jobs: list[QueueJob], profile: ApplyProfile) -> dict[str, int]:
    """Walk the queue. One job on screen at a time, in rank order."""
    tally = {ledger.APPLIED: 0, ledger.SKIPPED: 0, "error": 0}

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, channel="chrome")
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

    problems = missing_resumes(profile, [j.track for j in jobs])
    if problems:
        # Refusing to start is the point. Discovering a missing PDF at job three
        # means the founder has already reviewed a form he cannot submit.
        print("✗ Refusing to start — the queue needs resumes that are not on disk:")
        for problem in problems:
            print(f"    {problem}")
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
