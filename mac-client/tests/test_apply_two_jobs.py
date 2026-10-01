"""One page, many jobs: every decision reaches the job that is on screen.

THE DEFECT (found 2026-09-29 while fixing the recording holes). `run_queue`
reuses ONE page for the whole queue, and Playwright refuses to bind the same
name twice on a page. `process_job` bound `founderosDecision` per job and
swallowed that refusal, so from the second job on the binding still pointed at
the FIRST job's closure: the founder's click on job 2 was recorded against
job 1's id (job 1 "skipped" twice, or worse, marked applied after she skipped
it) and job 2's own future never resolved, so the queue stalled there. Every
existing test used a fresh page per test, which is why none of them saw it.

Local `file://` forms only: no network, $0.
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
from pathlib import Path

import pytest
import pytest_asyncio

from mac_client import apply as apply_mod
from mac_client import ledger
from mac_client.profile import ApplyProfile
from mac_client.sync import QueueJob

pytestmark = pytest.mark.asyncio

FIXTURES = Path(__file__).parent / "fixtures"

PROFILE = ApplyProfile(
    first_name="Tashi", last_name="Sharma", email="t@example.com", phone="+31600000001",
    resumes={}, default_resume="",
)


@pytest_asyncio.fixture
async def page():
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context()
        yield await context.new_page()
        await browser.close()


@pytest.fixture
def ledger_file(tmp_path, monkeypatch) -> Path:
    path = tmp_path / "outcomes.jsonl"
    for name in ("record", "pending", "clear"):
        monkeypatch.setattr(ledger, name, functools.partial(getattr(ledger, name), path=path))
    return path


def _job(number: int, fixture: str) -> QueueJob:
    return QueueJob(
        id=f"00000000-0000-0000-0000-00000000000{number}",
        company=f"Job {number} BV",
        title="Financial Analyst",
        track="finance",
        url=(FIXTURES / fixture).as_uri(),
        brief_rank=number,
    )


async def _decide(page, job: QueueJob, button: str) -> str:
    """Run one job to its decision on the SAME page, pressing `button` for it."""
    task = asyncio.ensure_future(apply_mod.process_job(page, job, PROFILE, f"{job.brief_rank} of 3"))
    try:
        await page.wait_for_selector(f"#founderos-bar:has-text('{job.company}')", timeout=15000)
        await page.click(f"#founderos-bar button:has-text('{button}')")
        return await asyncio.wait_for(asyncio.shield(task), timeout=8)
    finally:
        if not task.done():
            task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


async def test_every_job_on_a_reused_page_decides_for_itself(page, ledger_file):
    outcomes = [
        await _decide(page, _job(1, "greenhouse.html"), "SKIP"),
        # A positive success signal (the page says "Thank you, application
        # received"), so this does not depend on how a silent page is treated.
        await _decide(page, _job(2, "spa-success.html"), "SUBMIT"),
        await _decide(page, _job(3, "greenhouse.html"), "SKIP"),
    ]

    assert outcomes == ["skipped", "applied", "skipped"]
    # Each decision is on disk under ITS OWN row. Before the fix this read
    # [(1, skipped), (1, applied), (1, skipped)]: job 2's application landed on job 1.
    assert [(e.job_id[-1], e.outcome) for e in ledger.pending()] == [
        ("1", "skipped"), ("2", "applied"), ("3", "skipped"),
    ]
