"""The browser half, driven for real against local HTML forms.

THE FAILURE THIS GUARDS AGAINST. The prototype's overlay looked exactly like
ours and its submit line was commented out: the big green button recorded an
application that was never sent. Every job it "applied" to was still open and
the ledger said otherwise — a failure invisible from the ledger, from the logs,
and from the founder's side until a month of silence.

So these tests never assert on the overlay's appearance. They assert that the
EMPLOYER'S OWN submit handler ran (``window.__SUBMITTED__``), and that when no
submit button exists nothing is recorded at all. Everything runs against
``file://`` fixtures — no ATS traffic, no network, $0.
"""

from __future__ import annotations

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
    first_name="Pushkar",
    last_name="Verma",
    email="p@example.com",
    phone="+31600000000",
    resumes={},
    default_resume="",
)


def job_for(fixture: str, url_hint: str) -> QueueJob:
    """A queue row whose URL identifies the ATS but whose page is local.

    The adapter picks its field map from the URL, so the fixture is served from
    a file:// path while the job carries the real host. Splitting them is what
    lets us exercise the greenhouse map without touching greenhouse.
    """
    return QueueJob(
        id="00000000-0000-0000-0000-000000000001",
        company="Fixture BV",
        title="Site Reliability Engineer",
        track="backend",
        url=url_hint,
        brief_rank=1,
    )


async def open_fixture(page, fixture: str) -> None:
    await page.goto((FIXTURES / fixture).as_uri(), wait_until="domcontentloaded")


@pytest_asyncio.fixture
async def page():
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context()
        yield await context.new_page()
        await browser.close()


# --------------------------------------------------------------------------
# Filling
# --------------------------------------------------------------------------


async def test_greenhouse_form_gets_the_identity_fields(page):
    await open_fixture(page, "greenhouse.html")
    filled, _ = await apply_mod.fill_form(
        page, job_for("greenhouse.html", "https://boards.greenhouse.io/x/jobs/1"), PROFILE
    )

    assert await page.input_value("#first_name") == "Pushkar"
    assert await page.input_value("#email") == "p@example.com"
    assert "first name" in filled and "email" in filled


async def test_the_cover_letter_and_work_authorisation_are_left_alone(page):
    # The line the whole design rests on: a guessed work-permit answer is a
    # claim the founder never read, on a question that decides the application.
    await open_fixture(page, "greenhouse.html")
    await apply_mod.fill_form(
        page, job_for("greenhouse.html", "https://boards.greenhouse.io/x/jobs/1"), PROFILE
    )

    assert await page.input_value("#cover_letter") == ""
    assert await page.input_value("#work_auth") == ""


async def test_lever_single_name_field_is_filled_whole(page):
    await open_fixture(page, "lever.html")
    await apply_mod.fill_form(
        page, job_for("lever.html", "https://jobs.lever.co/mollie/abc"), PROFILE
    )
    assert await page.input_value("input[name=name]") == "Pushkar Verma"


async def test_an_unknown_ats_fills_nothing_and_says_so(page):
    await open_fixture(page, "greenhouse.html")
    filled, skipped = await apply_mod.fill_form(
        page, job_for("greenhouse.html", "https://careers.example.com/apply/1"), PROFILE
    )
    assert filled == []
    assert await page.input_value("#email") == ""
    assert any("not one we know" in s for s in skipped)


async def test_a_missing_field_is_reported_rather_than_silently_dropped(page):
    # no-submit.html has an email box and nothing else. A half-filled form the
    # founder believes is whole is the failure being prevented here.
    await open_fixture(page, "no-submit.html")
    filled, skipped = await apply_mod.fill_form(
        page, job_for("no-submit.html", "https://boards.greenhouse.io/x/jobs/1"), PROFILE
    )
    assert "email" in filled
    assert any("first name" in s and "no matching field" in s for s in skipped)


# --------------------------------------------------------------------------
# The click
# --------------------------------------------------------------------------


async def drive(page, fixture: str, url_hint: str, button: str, monkeypatch):
    """Run one job to its decision, pressing `button` from the test side.

    The stub goes on via monkeypatch, not by assignment: `apply_mod.ledger` IS
    the ledger module, so a plain assignment leaks into every later test in the
    session — which is exactly what it did the first time this was written.
    """
    recorded: list[tuple[str, str]] = []

    async def fake_record(job_id, outcome, **_kw):
        recorded.append((job_id, outcome))

    monkeypatch.setattr(ledger, "record", fake_record)
    await open_fixture(page, fixture)

    job = job_for(fixture, url_hint)
    filled, skipped = await apply_mod.fill_form(page, job, PROFILE)

    decided: list[str] = []

    async def on_decision(_source, outcome):
        await fake_record(job.id, outcome)
        decided.append(outcome)

    await page.expose_binding("founderosDecision", on_decision)
    await page.evaluate(
        apply_mod.OVERLAY_JS.read_text(),
        {"position": "1 of 1", "company": job.company, "title": job.title,
         "filled": filled, "skipped": skipped},
    )
    await page.click(f"#founderos-bar button:has-text('{button}')")
    await page.wait_for_timeout(1800)
    return decided, recorded


async def test_submit_presses_the_employers_own_button(page, monkeypatch):
    decided, recorded = await drive(
        page, "greenhouse.html", "https://boards.greenhouse.io/x/jobs/1", "SUBMIT", monkeypatch
    )
    # The employer's handler ran. This is the assertion the prototype failed.
    assert await page.evaluate("window.__SUBMITTED__") is True
    assert decided == ["applied"]
    assert recorded[0][1] == "applied"


async def test_lever_submit_also_reaches_the_real_button(page, monkeypatch):
    await drive(page, "lever.html", "https://jobs.lever.co/mollie/abc", "SUBMIT", monkeypatch)
    assert await page.evaluate("window.__SUBMITTED__") is True


async def test_skip_records_a_skip_and_never_submits(page, monkeypatch):
    decided, recorded = await drive(
        page, "greenhouse.html", "https://boards.greenhouse.io/x/jobs/1", "SKIP", monkeypatch
    )
    assert decided == ["skipped"]
    assert await page.evaluate("window.__SUBMITTED__ === undefined") is True


async def test_a_form_with_no_submit_button_records_nothing(page, monkeypatch):
    # The most dangerous case: recording an application that cannot have been
    # sent would drop the role out of every future queue with no trace.
    decided, recorded = await drive(
        page, "no-submit.html", "https://boards.greenhouse.io/x/jobs/1", "SUBMIT", monkeypatch
    )
    assert decided == []
    assert recorded == []
    text = await page.inner_text("#founderos-bar")
    assert "Could not find" in text


async def test_the_founder_can_still_skip_after_a_failed_submit(page, monkeypatch):
    # The buttons must be re-enabled, or the queue is stuck on a dead posting.
    decided, _ = await drive(
        page, "no-submit.html", "https://boards.greenhouse.io/x/jobs/1", "SUBMIT", monkeypatch
    )
    assert decided == []
    await page.click("#founderos-bar button:has-text('SKIP')")
    await page.wait_for_timeout(300)
    assert await page.evaluate("document.querySelector('#founderos-bar') !== null") is True


async def test_an_unmet_required_field_blocks_the_click_entirely(page, monkeypatch):
    # ADR-018: a form the browser itself would refuse to submit must never be
    # clicked, let alone recorded as applied. The founder finishes the field.
    decided, recorded = await drive(
        page, "required-field-missing.html", "https://boards.greenhouse.io/x/jobs/1", "SUBMIT", monkeypatch
    )
    assert decided == []
    assert recorded == []
    assert await page.evaluate("window.__SUBMITTED__ === undefined") is True
    text = await page.inner_text("#founderos-bar")
    assert "work_auth_text" in text or "required" in text.lower()


async def test_a_visible_validation_error_is_not_recorded_as_applied(page, monkeypatch):
    # ADR-018 (D2 regression guard): the site accepted the click but rejected
    # the submission and said so on the page. Recording "applied" here is the
    # exact false-positive this ADR exists to close.
    decided, recorded = await drive(
        page, "validation-error-shown.html", "https://boards.greenhouse.io/x/jobs/1", "SUBMIT", monkeypatch
    )
    assert decided == []
    assert recorded == []
    text = await page.inner_text("#founderos-bar")
    assert "already associated" in text.lower()


async def test_a_second_click_cannot_submit_twice(page, monkeypatch):
    await open_fixture(page, "greenhouse.html")
    calls: list[str] = []

    async def on_decision(_source, outcome):
        calls.append(outcome)

    await page.expose_binding("founderosDecision", on_decision)
    await page.evaluate(
        apply_mod.OVERLAY_JS.read_text(),
        {"position": "1 of 1", "company": "X", "title": "Y", "filled": [], "skipped": []},
    )
    await page.evaluate(
        "document.querySelectorAll('#founderos-bar button')[1].click()"
    )
    await page.evaluate(
        "document.querySelectorAll('#founderos-bar button')[1].click()"
    )
    await page.wait_for_timeout(1800)
    assert calls == ["applied"]
