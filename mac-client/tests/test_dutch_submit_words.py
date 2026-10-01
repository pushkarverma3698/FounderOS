"""Which button SUBMIT & NEXT presses when the form has no `type=submit` (English and Dutch).

The overlay first looks for a real submit control; only when there is none does it
look for a button by its words. A Dutch form whose send button is `type=button`
("Verzenden") used to fall through to "Could not find this form's submit button".

The rule for the Dutch words is the opposite of a loose match: only labels that can
ONLY mean "send it now". "Solliciteer" / "Solliciteren" (apply) is what the button
that OPENS the form says, so it is never treated as the final submit, and a Dutch
label is matched whole, never as a prefix, because "Verstuur naar een vriend"
(send to a friend) begins with a submit word.

A table, run in real Chromium over local HTML: one page per row, the employer's own
element counts its presses, and the row says whether SUBMIT & NEXT may press it.
"""

from __future__ import annotations

import pytest
import pytest_asyncio

from tests.harness import Overlay

pytestmark = pytest.mark.asyncio


def _button(label: str) -> str:
    return f'<button type="button" onclick="window.__PRESSED__ = true">{label}</button>'


#: Labels SUBMIT & NEXT may press: the English ones that always worked, and the Dutch final-submit phrases.
PRESSED = [
    "Submit", "SUBMIT", "Submit application", "Submit Application", "Apply now", "Apply Now", "Send application",
    "Verzenden", "VERZENDEN", "  Verzenden  ", "Versturen", "Verstuur",
    "Sollicitatie versturen", "Sollicitatie verzenden", "Verstuur sollicitatie",
    "Sollicitatie&nbsp;versturen",  # a no-break space is not a space to a naive comparison
]

#: Labels it must NOT press as the final submit: they open a form, go on, go back, or send something else.
NOT_PRESSED = [
    "Solliciteer", "Solliciteer nu", "Solliciteren", "Solliciteer direct", "Sollicitatie",
    "Apply", "Apply for this job", "Verstuur naar een vriend", "Verzenden naar een vriend",
    "Volgende", "Verder", "Terug", "Annuleren",
]

#: The same words on other kinds of clickable the overlay looks at.
OTHER_ELEMENTS = [
    ('<input type="button" value="Verzenden" onclick="window.__PRESSED__ = true">', True),
    ('<input type="button" value="Sollicitatie  versturen" onclick="window.__PRESSED__ = true">', True),
    ('<a role="button" onclick="window.__PRESSED__ = true">Versturen</a>', True),
    ('<input type="button" value="Solliciteer nu" onclick="window.__PRESSED__ = true">', False),
    ('<a role="button" onclick="window.__PRESSED__ = true">Solliciteren</a>', False),
]


@pytest_asyncio.fixture
async def context():
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        yield await browser.new_context()
        await browser.close()


async def _pressed(context, element_html: str) -> bool:
    """Open a page with `element_html`, press SUBMIT & NEXT, and say whether the employer's element was pressed."""
    page = await context.new_page()
    try:
        overlay = await Overlay(page).open(html=f"<!doctype html><body><h1>Application</h1>{element_html}</body>")
        await overlay.press("SUBMIT")
        await page.wait_for_function(
            "window.__PRESSED__ === true || "
            "(document.getElementById('founderos-bar')?.innerText || '').includes('Could not find')",
            timeout=5000,
        )
        return await page.evaluate("window.__PRESSED__ === true")
    finally:
        await page.close()


async def test_the_final_submit_words_press_and_nothing_else_does(context):
    got = {label: await _pressed(context, _button(label)) for label in PRESSED + NOT_PRESSED}
    expected = {**{label: True for label in PRESSED}, **{label: False for label in NOT_PRESSED}}
    assert got == expected


async def test_the_same_words_on_an_input_button_and_a_link_button(context):
    got = {html: await _pressed(context, html) for html, _ in OTHER_ELEMENTS}
    assert got == dict(OTHER_ELEMENTS)


async def test_with_an_apply_button_and_a_send_button_only_the_send_button_is_pressed(context):
    page = await context.new_page()
    html = (
        "<!doctype html><body>"
        '<button type="button" onclick="window.__OPENED__ = true">Solliciteer nu</button>'
        '<button type="button" onclick="window.__PRESSED__ = true">Verzenden</button></body>'
    )
    overlay = await Overlay(page).open(html=html)
    await overlay.press("SUBMIT")
    await page.wait_for_function("window.__PRESSED__ === true || window.__OPENED__ === true", timeout=5000)
    assert await page.evaluate("[window.__PRESSED__ === true, window.__OPENED__ === true]") == [True, False]
    await page.close()


async def test_a_real_submit_control_still_wins_over_a_button_found_by_its_words(context):
    # The first two lookups are untouched: a `type=submit` is pressed whatever it says.
    page = await context.new_page()
    html = (
        "<!doctype html><body><form>"
        '<button type="button" onclick="window.__WORDS__ = true">Verzenden</button>'
        '<button type="submit" onclick="event.preventDefault(); window.__PRESSED__ = true">Doorgaan</button>'
        "</form></body>"
    )
    overlay = await Overlay(page).open(html=html)
    await overlay.press("SUBMIT")
    await page.wait_for_function("window.__PRESSED__ === true || window.__WORDS__ === true", timeout=5000)
    assert await page.evaluate("[window.__PRESSED__ === true, window.__WORDS__ === true]") == [True, False]
    await page.close()
