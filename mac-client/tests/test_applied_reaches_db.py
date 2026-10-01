"""A submitted application reaches `job_applications.applied_at`; an OPENED form never does.

THE QUESTION (plan 2026-09-29, "apply is recorded"): production shows `applied_at`
set on 0 rows ever. Does the Mac client's flow post a submitted application back,
or does it need a new call? It already does. The chain, each link real here and
only the SSH hop faked:

    founder clicks SUBMIT & NEXT   overlay.js, `founderosDecision("applied")`
      -> apply.process_job         `on_decision` writes the outcome to the ledger
      -> ledger.record             one JSONL line, flushed to disk
      -> apply.flush_outcomes      at session end, and again at the next start
      -> sync.push_outcomes        UPDATE agents.job_applications SET applied_at = now() ...

so no second call was added. What was missing was a test of the whole chain, and
of the two properties that make it trustworthy:

  * OPENING a form records nothing. Only a decision the founder made writes to
    the ledger, so a queue of forms she opened and closed cannot mark anything
    applied.
  * A failed push keeps the ledger, and the retry is idempotent (`applied_at IS
    NULL` in the SQL), so a flaky connection neither loses nor double-stamps.

Local `file://` forms only: no ATS traffic, no network, $0.

A form that HARD-NAVIGATES when SUBMIT & NEXT is pressed (a plain POST that
redirects to a thank-you page) destroys the overlay before it can report. That used
to leave `process_job` waiting for ever with the ledger empty (measured 2026-09-29);
mac_client/after_submit.py now asks her on the new page and tests/test_hard_navigation.py
drives it. Every fixture here and in test_apply_browser.py calls `preventDefault`,
which is why they could not see it.
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
from pathlib import Path

import pytest
import pytest_asyncio

from mac_client import apply as apply_mod
from mac_client import ledger, sync
from mac_client.profile import ApplyProfile
from mac_client.sync import QueueJob, SyncError

pytestmark = pytest.mark.asyncio

FIXTURES = Path(__file__).parent / "fixtures"
JOB_ID = "00000000-0000-0000-0000-000000000001"

PROFILE = ApplyProfile(
    first_name="Tashi", last_name="Sharma", email="t@example.com", phone="+31600000001",
    resumes={}, default_resume="", profile_id="wife-nl-finance",
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
    """The real ledger functions, pointed at a temp file instead of .queue/."""
    path = tmp_path / "outcomes.jsonl"
    for name in ("record", "pending", "clear"):
        monkeypatch.setattr(ledger, name, functools.partial(getattr(ledger, name), path=path))
    return path


@pytest.fixture
def ssh(monkeypatch) -> list[str]:
    """The only faked hop: every SQL statement that would have gone to the VPS."""
    sent: list[str] = []
    monkeypatch.setattr(sync, "run_remote", lambda sql: sent.append(sql) or "1")
    return sent


def _job() -> QueueJob:
    return QueueJob(
        id=JOB_ID, company="Fixture BV", title="Financial Analyst", track="finance",
        # A page that confirms in place ("Thank you, application received"), so
        # pressing SUBMIT is a POSITIVE signal. A page that stays silent is asked
        # about instead: tests/test_overlay_decisions.py.
        url=(FIXTURES / "spa-success.html").as_uri(), brief_rank=1,
    )


@contextlib.asynccontextmanager
async def _job_on_screen(page):
    """`process_job` running, the overlay up, waiting for the founder."""
    task = asyncio.ensure_future(apply_mod.process_job(page, _job(), PROFILE, "1 of 1"))
    try:
        await page.wait_for_selector("#founderos-bar", timeout=15000)
        yield task
    finally:
        if not task.done():
            task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


async def test_opening_a_form_records_nothing(page, ledger_file, ssh):
    async with _job_on_screen(page) as task:
        await asyncio.sleep(0.8)
        assert not task.done(), "the job must be waiting for the founder"
        assert not ledger_file.exists()
        assert ledger.pending() == []

    # Nothing to push, so nothing is sent: the row stays in tomorrow's queue.
    assert apply_mod.flush_outcomes() == 0
    assert ssh == []


async def test_an_in_page_submit_writes_applied_at_for_exactly_that_row(page, ledger_file, ssh):
    async with _job_on_screen(page) as task:
        await page.click("#founderos-bar button:has-text('SUBMIT')")
        assert await asyncio.wait_for(task, timeout=15) == ledger.APPLIED

    # The employer's own handler ran (it is the founder's click that sent it) ...
    assert await page.evaluate("window.__SUBMITTED__") is True
    # ... the decision is on disk before anything was pushed ...
    assert [(e.job_id, e.outcome) for e in ledger.pending()] == [(JOB_ID, "applied")]
    assert ssh == []

    # ... and the session-end flush stamps applied_at on that id, then clears the ledger.
    assert apply_mod.flush_outcomes() == 1
    assert len(ssh) == 1
    assert "SET applied_at = now()" in ssh[0]
    assert f"'{JOB_ID}'" in ssh[0]
    assert "skipped_at" not in ssh[0]
    assert "applied_at IS NULL" in ssh[0]
    assert not ledger_file.exists()


async def test_skip_stamps_skipped_at_and_never_applied_at(page, ledger_file, ssh):
    async with _job_on_screen(page) as task:
        await page.click("#founderos-bar button:has-text('SKIP')")
        assert await asyncio.wait_for(task, timeout=15) == ledger.SKIPPED

    assert await page.evaluate("window.__SUBMITTED__ === undefined") is True
    apply_mod.flush_outcomes()
    assert len(ssh) == 1
    assert "SET skipped_at = now()" in ssh[0]
    assert "applied_at" not in ssh[0]


async def test_a_failed_push_keeps_the_ledger_and_the_retry_is_safe(page, ledger_file, monkeypatch):
    async with _job_on_screen(page) as task:
        await page.click("#founderos-bar button:has-text('SUBMIT')")
        await asyncio.wait_for(task, timeout=15)

    def unreachable(_sql):
        raise SyncError("founderos-vps did not answer within 60s")

    monkeypatch.setattr(sync, "run_remote", unreachable)
    with pytest.raises(SyncError):
        apply_mod.flush_outcomes()
    # The VPS was unreachable: the application is still on disk, to be pushed
    # by the next run's start-up recovery. Clearing on attempt would lose it.
    assert [e.job_id for e in ledger.pending()] == [JOB_ID]

    sent: list[str] = []
    monkeypatch.setattr(sync, "run_remote", lambda sql: sent.append(sql) or "1")
    assert apply_mod.flush_outcomes() == 1
    assert "applied_at IS NULL" in sent[0]  # a second push cannot move an earlier timestamp
    assert not ledger_file.exists()
