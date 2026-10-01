"""SUBMIT STAYS HUMAN: nothing in the fill path can press the employer's button.

THE INCIDENT. On 2026-08-24 `submit_application` clicked Submit before any
approval existed. The rule since (ADR-018) is that the machine fills, then
STOPS, and the only click that sends an application is the founder's own on the
overlay's SUBMIT & NEXT. This file pins the fill side of that rule three ways:

  * statically: no adapter, resolver or fill function contains a call that
    clicks, submits or presses Enter, and none names a submit button ("Submit",
    "Verzenden", "Versturen", "Solliciteer");
  * in a real browser: filling English and Dutch forms fires no click, no submit
    and no Enter keypress, and the employer's own handler never runs;
  * on the value: a profile value holding a line break is never typed, because
    typing "\\n" presses Enter and Enter in a text field submits the form. That
    path was real (a stray newline in `linkedin`, which is never stripped, would
    have sent the application before the founder saw the page).

The overlay's SUBMIT & NEXT button is the one deliberate exception: it is the
human click, and it lives in overlay.js, outside everything scanned here.
"""

from __future__ import annotations

import ast
import inspect
import textwrap
from pathlib import Path

import pytest
import pytest_asyncio

from mac_client import adapters, apply as apply_mod, resolver
from mac_client.adapters import is_typable
from mac_client.profile import ApplyProfile
from mac_client.sync import QueueJob

FIXTURES = Path(__file__).parent / "fixtures"

PROFILE = ApplyProfile(
    first_name="Tashi",
    last_name="Sharma",
    email="t@example.com",
    phone="+31600000001",
    resumes={},
    default_resume="",
)

# Attribute calls that act on the page rather than read it or type text.
FORBIDDEN_CALLS = {"click", "dblclick", "tap", "dispatch_event", "submit", "request_submit", "check", "set_checked"}
# `press` is allowed for the select-all chord that clears a field, nothing else.
ALLOWED_PRESSES = {"Meta+A", "Control+A"}
# Words that name the employer's send button, in English and Dutch.
BUTTON_WORDS = ("submit", "verzend", "versturen", "solliciteer", "apply now", "send application")
# The one legitimate mention: the resolver skips submit inputs when collecting fields.
EXCLUDING_SUBMIT_INPUTS = ':not([type="submit"])'
JS_ACTIONS = (".click(", ".submit(", "requestsubmit", "dispatchevent", "mouseevent", "keyboardevent", "'enter'", '"enter"')


def _parse(source: str) -> ast.Module:
    return ast.parse(textwrap.dedent(source))


def _docstring_nodes(tree: ast.AST) -> set[int]:
    ids = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = node.body
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                ids.add(id(body[0].value))
    return ids


def _code_violations(name: str, source: str) -> list[str]:
    """Every clicking/submitting call and every button word in the CODE of `source`
    (comments and docstrings are prose and are not scanned)."""
    tree = _parse(source)
    skip = _docstring_nodes(tree)
    found: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            attr = node.func.attr
            if attr in FORBIDDEN_CALLS:
                found.append(f"{name}: calls .{attr}()")
            if attr == "press":
                arg = node.args[0].value if node.args and isinstance(node.args[0], ast.Constant) else None
                if arg not in ALLOWED_PRESSES:
                    found.append(f"{name}: presses {arg!r}, only {sorted(ALLOWED_PRESSES)} is allowed")
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in skip:
            text = node.value.replace(EXCLUDING_SUBMIT_INPUTS, "").lower()
            for word in BUTTON_WORDS:
                if word in text:
                    found.append(f"{name}: a string mentions {word!r}")
            if "\n" in node.value:  # embedded JavaScript
                for action in JS_ACTIONS:
                    if action in text:
                        found.append(f"{name}: JavaScript contains {action!r}")
    return found


def _function_source(fn) -> str:
    return inspect.getsource(fn)


def test_no_adapter_resolver_or_fill_function_can_click_submit_or_press_enter():
    scanned = {
        "adapters.py": inspect.getsource(adapters),
        "resolver.py": inspect.getsource(resolver),
        "apply.fill_form": _function_source(apply_mod.fill_form),
        "apply._fill_first": _function_source(apply_mod._fill_first),
        "apply._upload_first": _function_source(apply_mod._upload_first),
    }
    violations = [v for name, source in scanned.items() for v in _code_violations(name, source)]
    assert violations == []


def test_the_scan_would_catch_a_click_and_a_dutch_submit_button():
    # A guard that cannot fail proves nothing: feed it the two things it exists for.
    bad = """
    async def fill(page):
        await page.get_by_role("button", name="Verzenden").click()
        await page.keyboard.press("Enter")
    """
    found = _code_violations("bad", bad)
    assert any(".click()" in v for v in found)
    assert any("'Enter'" in v for v in found)
    assert any("verzend" in v for v in found)


# -- in a real browser --------------------------------------------------------------

SPY_JS = """
() => {
  window.__EVENTS__ = [];
  for (const type of ['click', 'dblclick', 'submit']) {
    document.addEventListener(type, () => window.__EVENTS__.push(type), true);
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter') window.__EVENTS__.push('Enter'); }, true);
}
"""


@pytest_asyncio.fixture
async def page():
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context()
        yield await context.new_page()
        await browser.close()


def _job(url: str) -> QueueJob:
    return QueueJob(
        id="00000000-0000-0000-0000-000000000001",
        company="Fixture BV",
        title="Financial Analyst",
        track="finance",
        url=url,
        brief_rank=1,
    )


async def _fill(page, fixture: str, url: str, profile: ApplyProfile = PROFILE):
    await page.goto((FIXTURES / fixture).as_uri(), wait_until="domcontentloaded")
    await page.evaluate(SPY_JS)
    result = await apply_mod.fill_form(page, _job(url), profile)
    return result, await page.evaluate("window.__EVENTS__"), await page.evaluate("window.__SUBMITTED__ === true")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fixture, url",
    [
        ("greenhouse.html", "https://boards.greenhouse.io/x/jobs/1"),
        ("lever.html", "https://jobs.lever.co/mollie/abc"),
        # The Dutch form, with a real "Verzenden" button in it.
        ("greenhouse-nl.html", "https://boards.greenhouse.io/x/jobs/1"),
    ],
)
async def test_filling_a_form_fires_no_click_no_submit_and_no_enter(page, fixture, url):
    (filled, _skipped), events, employer_handler_ran = await _fill(page, fixture, url)
    assert filled, "the fixture must actually be filled for this test to mean anything"
    assert events == []
    assert employer_handler_ran is False


@pytest.mark.asyncio
async def test_a_line_break_in_a_profile_value_is_not_typed_and_does_not_submit(page):
    # Typing "\n" presses Enter, and Enter in a text field submits the form.
    profile = ApplyProfile(
        first_name="Ta\nshi", last_name="Sharma", email="t@example.com", phone="+31600000001",
        resumes={}, default_resume="",
    )
    (filled, skipped), events, employer_handler_ran = await _fill(
        page, "greenhouse.html", "https://boards.greenhouse.io/x/jobs/1", profile
    )
    assert employer_handler_ran is False
    assert events == []
    assert "first name" not in filled
    # Said out loud, with the reason and the fix: not silently dropped.
    reason = next(s for s in skipped if s.startswith("first name"))
    assert "line break" in reason and "apply-profile.json" in reason
    assert await page.input_value("#first_name") == ""
    # The other fields are unaffected.
    assert "email" in filled


@pytest.mark.parametrize("value", ["Tashi", "+31 6 00 00 00 01", "Çelik", "O'Neil-Verma", "t@example.com"])
def test_ordinary_values_are_typable(value):
    assert is_typable(value)


@pytest.mark.parametrize("value", ["a\nb", "a\r\nb", "trailing\n", "a\tb", "a\x1bb", "a\x7fb", "a\u2028b", "a\u2029b", "a\x85b"])
def test_values_that_would_press_a_key_are_not_typable(value):
    assert not is_typable(value)
