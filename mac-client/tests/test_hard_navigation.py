"""A form that navigates when SUBMIT & NEXT is pressed: she is asked, nothing is assumed (ADR-018).

THE HOLE (measured 2026-09-29, written up in tests/test_applied_reaches_db.py).
The decision bar is JavaScript in the page, so it dies with the page. A form that
HARD-NAVIGATES when the founder presses SUBMIT & NEXT (a plain POST that
redirects to a thank-you page) sends the application and destroys the bar in the
same breath: nothing calls `founderosDecision`, `process_job` waits for ever, the
ledger stays empty and the row is offered again tomorrow. Every other fixture
calls `preventDefault`, which is why no test saw it.

The rule these tests pin: after a submit was attempted and no decision was
recorded, a navigation makes the host put the SAME "Did the application go
through?" bar on the new page. "applied" is written only from her YES. A
navigation is never evidence: the new page's address always differs, the old
button is always gone, and a page that says "Thank you" has no baseline to be
compared with, so even that is a question.

Real Chromium against a real HTTP server on 127.0.0.1: no network, $0. (A form
POST needs a server; `file://` cannot do one.)
"""

from __future__ import annotations

import ast
import asyncio
import contextlib
import functools
import inspect
from pathlib import Path

import pytest
import pytest_asyncio

from mac_client import apply as apply_mod
from mac_client import ledger
from mac_client.profile import ApplyProfile
from mac_client.sync import QueueJob
from tests.harness import LocalSite, Overlay, Reply

JOB_ID = "00000000-0000-0000-0000-000000000001"
QUESTION = "Did the application go through"
#: Longer than the overlay's 1.2 s settle window: "nothing was recorded" is then a
#: statement about a decision that had every chance to be made.
PAST_SETTLE_MS = 2500

PROFILE = ApplyProfile(
    first_name="Tashi", last_name="Sharma", email="t@example.com", phone="+31600000001",
    resumes={}, default_resume="", profile_id="wife-nl-finance",
)


def _form(action: str, script: str = "", extra: str = "") -> str:
    return (
        "<!doctype html><html><body><h1>Application</h1>"
        f"{extra}"
        f'<form method="post" action="{action}">'
        '<input id="first_name" name="first_name" placeholder="First name">'
        '<input id="email" name="email" type="email" placeholder="Email">'
        '<button type="submit" id="real-submit">Submit application</button>'
        f"</form>{script}</body></html>"
    )


def _page(body: str) -> str:
    return f"<!doctype html><html><body>{body}</body></html>"


PAGES = {
    # POST, then a 302 to a thank-you page: the textbook hard navigation.
    ("GET", "/apply"): Reply(_form("/submit")),
    ("POST", "/submit"): Reply(status=302, location="/thanks"),
    ("GET", "/thanks"): Reply(_page("<h1>Thank you</h1><p>Thank you, application received.</p>")),
    # POST, then a page that says nothing at all (no "thank you", no error).
    ("GET", "/apply-silent"): Reply(_form("/silent")),
    ("POST", "/silent"): Reply(_page("<h1>Fixture BV</h1><p>Done.</p>")),
    # A thank-you page that sends the browser on to the careers site after 2 s.
    ("GET", "/apply-bounce"): Reply(_form("/bounce")),
    ("POST", "/bounce"): Reply(
        '<!doctype html><html><head><meta http-equiv="refresh" content="2;url=/home"></head>'
        "<body><h1>Thank you</h1></body></html>"
    ),
    ("GET", "/home"): Reply(_page("<h1>Careers at Fixture BV</h1>")),
    # A second step reached by a link: the page changes, nothing was submitted.
    ("GET", "/apply-multistep"): Reply(_form("/never", extra='<a id="next" href="/step2">Next step</a>')),
    ("GET", "/step2"): Reply(_page("<h1>Step 2</h1>")),
    # An in-document change after the click (a hash route): the same page, the bar is still there.
    ("GET", "/apply-hash"): Reply(
        _form(
            "/never",
            script=(
                "<script>document.getElementById('real-submit').addEventListener('click', function (e) {"
                "e.preventDefault(); window.__SUBMITTED__ = true; location.hash = '#sent'; });</script>"
            ),
        )
    ),
    # POST, then a page whose first bytes arrive and whose end never does.
    ("GET", "/apply-hang"): Reply(_form("/hang")),
    ("POST", "/hang"): Reply(hold=True),
}


@pytest_asyncio.fixture
async def page():
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context()
        yield await context.new_page()
        await browser.close()


@pytest.fixture
def site():
    with LocalSite(PAGES) as running:
        yield running


@pytest.fixture
def ledger_file(tmp_path, monkeypatch) -> Path:
    path = tmp_path / "outcomes.jsonl"
    for name in ("record", "pending", "clear"):
        monkeypatch.setattr(ledger, name, functools.partial(getattr(ledger, name), path=path))
    return path


def _job(url: str) -> QueueJob:
    return QueueJob(
        id=JOB_ID, company="Fixture BV", title="Financial Analyst", track="finance",
        url=url, brief_rank=1,
    )


@contextlib.asynccontextmanager
async def _job_on_screen(page, url: str):
    """`process_job` running on `url`, the overlay up, waiting for the founder."""
    task = asyncio.ensure_future(apply_mod.process_job(page, _job(url), PROFILE, "1 of 1"))
    try:
        await page.wait_for_selector("#founderos-bar", timeout=15000)
        yield task
    finally:
        if not task.done():
            task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task


def _not_recorded_lines(captured: str) -> list[str]:
    return [line for line in captured.splitlines() if "[NOT RECORDED]" in line]


# -- the page was replaced by the click -----------------------------------------------


@pytest.mark.asyncio
async def test_a_form_that_posts_and_redirects_is_asked_about_and_yes_records_applied(page, site, ledger_file):
    overlay = Overlay(page)
    async with _job_on_screen(page, site.url("/apply")) as task:
        await overlay.press("SUBMIT")

        await overlay.wait_for_bar_text(QUESTION, timeout=10000)
        assert page.url == site.url("/thanks")  # the page really was replaced ...
        assert site.posts == ["/submit"]  # ... by a form the employer really received, once
        assert not task.done() and ledger.pending() == []  # nothing is recorded by the question

        await overlay.press("YES")
        assert await asyncio.wait_for(task, timeout=10) == ledger.APPLIED

    assert [(e.job_id, e.outcome) for e in ledger.pending()] == [(JOB_ID, "applied")]


@pytest.mark.asyncio
async def test_a_thank_you_page_after_a_hard_navigation_is_still_only_a_question(page, site, ledger_file):
    # "Thank you, application received" is the page's own claim and it has no
    # baseline to be compared with (the form it replaced is gone), so it is not
    # evidence either: the founder reads it and presses YES.
    overlay = Overlay(page)
    async with _job_on_screen(page, site.url("/apply")) as task:
        await overlay.press("SUBMIT")
        await overlay.wait_for_bar_text(QUESTION, timeout=10000)
        await page.wait_for_timeout(PAST_SETTLE_MS)

        assert "thank you" in (await page.inner_text("body")).lower()
        assert ledger.pending() == [] and not task.done()


@pytest.mark.asyncio
async def test_a_form_that_navigates_to_a_page_that_says_nothing_is_asked_about(page, site, ledger_file):
    overlay = Overlay(page)
    async with _job_on_screen(page, site.url("/apply-silent")) as task:
        await overlay.press("SUBMIT")

        await overlay.wait_for_bar_text(QUESTION, timeout=10000)
        await page.wait_for_timeout(PAST_SETTLE_MS)
        assert site.posts == ["/silent"]
        assert ledger.pending() == [] and not task.done()
        assert await overlay.has_button("YES") and await overlay.has_button("NO")


@pytest.mark.asyncio
async def test_no_after_a_hard_navigation_records_nothing_says_so_once_and_gives_the_buttons_back(
    page, site, ledger_file, capsys
):
    overlay = Overlay(page)
    async with _job_on_screen(page, site.url("/apply-silent")) as task:
        await overlay.press("SUBMIT")
        await overlay.wait_for_bar_text(QUESTION, timeout=10000)

        await overlay.press("NO")
        await overlay.wait_for_bar_text("Not recorded")
        await page.wait_for_timeout(300)  # let the host's line land
        assert ledger.pending() == [] and not task.done()
        assert await overlay.is_enabled("SKIP") and await overlay.is_enabled("SUBMIT")
        assert await overlay.has_button("I SUBMITTED IT MYSELF")

        lines = _not_recorded_lines(capsys.readouterr().out)
        assert len(lines) == 1, lines  # one line, in the terminal she runs this from
        assert "Fixture BV" in lines[0] and "Financial Analyst" in lines[0]
        assert "NO" in lines[0] and "Nothing was recorded" in lines[0]

        # She can still decide: SKIP records skipped and ends the job, never applied.
        await overlay.press("SKIP")
        assert await asyncio.wait_for(task, timeout=10) == ledger.SKIPPED

    assert [(e.job_id, e.outcome) for e in ledger.pending()] == [(JOB_ID, "skipped")]


# -- the page changed, but not because she submitted -----------------------------------


@pytest.mark.asyncio
async def test_a_navigation_before_any_submit_attempt_shows_no_question(page, site, ledger_file):
    async with _job_on_screen(page, site.url("/apply-multistep")) as task:
        await page.click("#next")  # her own click on the employer's link: nothing is submitted
        await page.wait_for_url(site.url("/step2"), timeout=10000)
        await page.wait_for_timeout(PAST_SETTLE_MS)

        assert site.posts == []
        assert QUESTION not in await page.inner_text("body")
        assert await page.locator("#founderos-bar").count() == 0
        assert ledger.pending() == [] and not task.done()


@pytest.mark.asyncio
async def test_a_hash_change_after_submit_is_the_same_page_not_a_new_one(page, site, ledger_file):
    # An in-document route change leaves the overlay where it is; replacing it
    # would throw away the settle window it is still running.
    overlay = Overlay(page)
    async with _job_on_screen(page, site.url("/apply-hash")) as task:
        await overlay.press("SUBMIT")
        await page.wait_for_function("window.__SUBMITTED__ === true")
        await page.wait_for_timeout(500)  # well inside the overlay's 1.2 s settle window
        assert QUESTION not in await overlay.bar_text()

        await overlay.wait_for_bar_text(QUESTION)  # its own question, once the window is over
        await overlay.press("YES")
        assert await asyncio.wait_for(task, timeout=10) == ledger.APPLIED


@pytest.mark.asyncio
async def test_the_question_follows_the_founder_when_the_thank_you_page_redirects_on(page, site, ledger_file):
    overlay = Overlay(page)
    async with _job_on_screen(page, site.url("/apply-bounce")) as task:
        await overlay.press("SUBMIT")
        await overlay.wait_for_bar_text(QUESTION, timeout=10000)
        assert page.url == site.url("/bounce")

        await page.wait_for_url(site.url("/home"), timeout=10000)  # the page's own redirect, 2 s later
        await overlay.wait_for_bar_text(QUESTION, timeout=10000)  # and the question is on that page too
        assert ledger.pending() == [] and not task.done()

        await overlay.press("YES")
        assert await asyncio.wait_for(task, timeout=10) == ledger.APPLIED


# -- the machine could not ask ---------------------------------------------------------


@pytest.mark.asyncio
async def test_a_page_that_never_finishes_loading_records_nothing_and_says_so(
    page, site, ledger_file, monkeypatch, capsys
):
    from mac_client import after_submit

    monkeypatch.setattr(after_submit, "LOAD_TIMEOUT_MS", 800)
    overlay = Overlay(page)
    async with _job_on_screen(page, site.url("/apply-hang")) as task:
        await overlay.press("SUBMIT")
        with pytest.raises(after_submit.NavigationUnconfirmed):
            await asyncio.wait_for(task, timeout=10)

    assert ledger.pending() == []
    lines = _not_recorded_lines(capsys.readouterr().out)
    assert len(lines) == 1, lines
    assert "Fixture BV" in lines[0] and "never finished loading" in lines[0] and "Nothing was recorded" in lines[0]


# -- the host side only asks -----------------------------------------------------------


def _code_strings_and_names(source: str) -> tuple[set[str], set[str]]:
    """Every identifier and string constant in the CODE of `source` (docstrings are prose)."""
    tree = ast.parse(source)
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = node.body
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                docstrings.add(id(body[0].value))
    names: set[str] = set()
    strings: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            names.add(node.id)
        elif isinstance(node, ast.Attribute):
            names.add(node.attr)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            names.update(alias.asname or alias.name for alias in node.names)
            if isinstance(node, ast.ImportFrom) and node.module:
                names.add(node.module)
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
            strings.add(node.value)
    return names, strings


def test_the_navigation_watcher_never_writes_the_ledger_or_names_applied():
    from mac_client import after_submit

    names, strings = _code_strings_and_names(inspect.getsource(after_submit))
    assert "ledger" not in names and "record" not in names
    assert "set_result" not in names  # it may fail the job's future (set_exception), never complete it
    assert not any("applied" in s.lower() for s in strings)


def test_the_scan_would_catch_a_watcher_that_records():
    bad = '''
from . import ledger

def on_navigated(job):
    ledger.record(job.id, "applied")
'''
    names, strings = _code_strings_and_names(bad)
    assert "ledger" in names and "record" in names and "applied" in strings
