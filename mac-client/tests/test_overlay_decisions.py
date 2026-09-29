"""What the overlay records after the founder presses SUBMIT & NEXT (ADR-018).

"applied" is written from exactly two things: a POSITIVE signal the page gives
(the URL changes, the form disappears, or it says "Thank you, application
received"), or the founder's own YES to "Did the application go through?".
A page that says nothing either way is NOT success: an employer's handler that
ran clean and one that silently did nothing look identical from here, so the
overlay asks. Until 2026-09-29 it decided for her, after 1.2 seconds, and wrote
"applied" (the file's own comment says it never should).

Real Chromium over local pages: no ATS traffic, no network, $0.
"""

from __future__ import annotations

import pytest
import pytest_asyncio

from tests.harness import Overlay

pytestmark = pytest.mark.asyncio

#: Longer than the overlay's 1.2 s settle window, so "nothing was recorded" is
#: a statement about a decision that had every chance to be made.
PAST_SETTLE_MS = 2500


@pytest_asyncio.fixture
async def page():
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context()
        yield await context.new_page()
        await browser.close()


async def test_a_page_that_says_nothing_is_asked_about_never_recorded(page):
    overlay = await Overlay(page).open(fixture="greenhouse.html")
    await overlay.press("SUBMIT")

    await overlay.wait_for_bar_text("Did the application go through")
    await page.wait_for_timeout(PAST_SETTLE_MS)
    assert await page.evaluate("window.__SUBMITTED__") is True  # her click did reach the employer's handler
    assert overlay.decisions == []  # ... and nothing was written on her behalf
    assert await overlay.has_button("YES") and await overlay.has_button("NO")


async def test_yes_is_an_explicit_confirmation_and_records_applied(page):
    overlay = await Overlay(page).open(fixture="greenhouse.html")
    await overlay.press("SUBMIT")
    await overlay.wait_for_bar_text("Did the application go through")

    await overlay.press("YES")
    await page.wait_for_timeout(300)
    assert overlay.decisions == ["applied"]


async def test_no_records_nothing_and_gives_the_buttons_back(page):
    overlay = await Overlay(page).open(fixture="greenhouse.html")
    await overlay.press("SUBMIT")
    await overlay.wait_for_bar_text("Did the application go through")

    await overlay.press("NO")
    await overlay.wait_for_bar_text("Not recorded")
    assert overlay.decisions == []
    # Back in the give-back state: she can fix it and press SUBMIT again, or SKIP.
    assert await page.locator("#founderos-bar button:has-text('SUBMIT')").is_enabled()
    assert await page.locator("#founderos-bar button:has-text('SKIP')").is_enabled()


async def test_a_positive_success_signal_records_applied_without_asking(page):
    overlay = await Overlay(page).open(fixture="spa-success.html")
    await overlay.press("SUBMIT")

    await page.wait_for_function("window.__SUBMITTED__ === true")
    await page.wait_for_timeout(600)
    assert overlay.decisions == ["applied"]
    assert not await overlay.has_button("YES")


async def test_a_failure_signal_gives_back_and_records_nothing(page):
    overlay = await Overlay(page).open(fixture="validation-error-shown.html")
    await overlay.press("SUBMIT")

    await overlay.wait_for_bar_text("was not submitted")
    await page.wait_for_timeout(PAST_SETTLE_MS)
    assert overlay.decisions == []
    assert not await overlay.has_button("YES")  # a page that said "failed" is not asked about
