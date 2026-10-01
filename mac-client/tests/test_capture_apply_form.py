"""tools/capture_apply_form.py: read-only, and provably so, on a local shadow-DOM page.

The tool saves the rendered DOM of one apply page so a field map can be written from the
real thing. What these tests pin is what makes it safe to run on a real employer's page:

  * it loads ONE url and does nothing else: no click, no key, no input, no submit
    (the page reports every such event back to the test's own server, and none arrives);
  * `--click` is the only action, it presses at most one button, and it refuses anything
    that looks like sending an application, before a browser even starts, and again at the
    element when that control would submit a form whatever its label says;
  * the saved DOM has no scripts, styles, images, links or hidden-field values, and its
    open shadow roots are inlined so the file rebuilds the same tree when loaded again.

STATUS: it has NEVER been run against SmartRecruiters or any real site. Local page only,
no network.
"""

from __future__ import annotations

import ast
import importlib.util
import inspect
import json
import re
import sys
import time
from pathlib import Path

import pytest

from tests.harness import LocalSite, Reply

TOOL_PATH = Path(__file__).resolve().parent.parent / "tools" / "capture_apply_form.py"
_spec = importlib.util.spec_from_file_location("capture_apply_form", TOOL_PATH)
tool = importlib.util.module_from_spec(_spec)
sys.modules["capture_apply_form"] = tool  # a dataclass in the module looks itself up here
_spec.loader.exec_module(tool)

#: What a page does if anything touches it: tell the server. The tool must cause none of it.
LOG = """<script>
for (const type of ['click', 'input', 'keydown', 'change', 'submit']) {
  document.addEventListener(type, () => fetch('/log/' + type, {keepalive: true}), true);
}
</script>"""

SHADOW_FORM = (
    '<label>Voornaam <input id="first" name="first" type="text" autocomplete="given-name"></label>'
    '<input type="hidden" name="csrf_field" value="SECRET-VALUE">'
    '<button type="submit">Verzenden</button>'
)

APPLY = """<!doctype html><html lang="nl"><head><title>Vacature Analist</title>
<style>body { font-family: sans-serif }</style>
<script>window.PAGE_SCRIPT_MARKER = 1;</script>@LOG@</head>
<body><img src="/logo.png" alt="logo"><svg><circle r="1"></circle></svg>
<a href="/elsewhere">Meer vacatures</a>
<iframe src="/frame"></iframe>
<x-form id="host"></x-form>
<script>
const root = document.getElementById('host').attachShadow({mode: 'open'});
root.innerHTML = @FORM@;
for (const type of ['click', 'input', 'keydown', 'change', 'submit']) {
  root.addEventListener(type, () => fetch('/log/' + type, {keepalive: true}));
}
</script></body></html>""".replace("@LOG@", LOG).replace("@FORM@", json.dumps(SHADOW_FORM))

REVEAL = """<!doctype html><html lang="en"><head><title>Job</title>@LOG@</head><body>
<h1>Analyst</h1>
<button id="reveal" type="button">Toon formulier</button>
<x-form id="host"></x-form>
<script>
document.getElementById('reveal').addEventListener('click', () => {
  const root = document.getElementById('host').attachShadow({mode: 'open'});
  root.innerHTML = '<label>Voornaam <input id="first" name="first"></label>';
});
</script></body></html>""".replace("@LOG@", LOG)

GUARD = """<!doctype html><html><head><title>Controls</title>@LOG@</head><body>
<form><button type="submit">Continue</button></form>
<form><button>Next</button></form>
<form><button type="button">More options</button></form>
<form><a role="button">Expand</a></form>
<form><x-btn role="button" aria-label="Go on"></x-btn></form>
<button type="button">Show more</button>
<button type="button">Same</button><button type="button">Same</button>
</body></html>""".replace("@LOG@", LOG)

PAGES = {
    ("GET", "/apply"): Reply(APPLY),
    ("GET", "/frame"): Reply("<!doctype html><p>inside a frame</p>"),
    ("GET", "/reveal"): Reply(REVEAL),
    ("GET", "/guard"): Reply(GUARD),
    ("GET", "/noform"): Reply("<!doctype html><html><head><title>Closed</title></head><body><p>No form here.</p></body></html>"),
}


@pytest.fixture
def site():
    with LocalSite(PAGES) as running:
        yield running


def _touched(site: LocalSite) -> list[str]:
    """Every event the page reported: what was clicked, typed, changed or submitted on it."""
    return [path for _method, path in site.seen if path.startswith("/log/")]


async def _capture(site, tmp_path, path, **kwargs):
    kwargs.setdefault("controls_timeout_ms", 300)
    kwargs.setdefault("settle_ms", 50)
    return await tool.capture(site.url(path), tmp_path / "out", **kwargs)


# -- what it saves ----------------------------------------------------------------------


@pytest.mark.asyncio
async def test_it_saves_the_form_inside_the_shadow_root_and_nothing_the_page_runs_on(site, tmp_path):
    started = time.monotonic()
    result = await _capture(site, tmp_path, "/apply", controls_timeout_ms=8000, locale="nl-NL")
    # The only input is inside a shadow root. Waiting for "an input" must see it at once: a wait that
    # could not would run out its 8 s before the capture, and a form it had not waited for is a form
    # that may not have rendered yet.
    assert time.monotonic() - started < 6

    dom = result.files["dom"].read_text(encoding="utf-8")
    assert '<template shadowrootmode="open">' in dom  # the open shadow root is inlined
    assert 'id="first"' in dom and 'autocomplete="given-name"' in dom
    for gone in ("<script", "<style", "<img", "<svg", "<iframe", "href=", "PAGE_SCRIPT_MARKER", "/logo.png", "SECRET-VALUE"):
        assert gone not in dom, gone
    assert 'name="csrf_field"' in dom and 'value=""' in dom  # the hidden field keeps its name, not its value

    controls = json.loads(result.files["controls"].read_text(encoding="utf-8"))
    first = next(c for c in controls if c["attrs"].get("id") == "first")
    assert first["path"] == "document>x-form" and first["visible"] and first["label"] == "Voornaam"
    assert {c["tag"] for c in controls} >= {"x-form", "input", "button"}
    assert result.has_form
    assert not any("SECRET-VALUE" in json.dumps(c) for c in controls)

    meta = json.loads(result.files["meta"].read_text(encoding="utf-8"))
    assert (meta["title"], meta["lang"], meta["status"], meta["locale_sent"]) == ("Vacature Analist", "nl", 200, "nl-NL")
    assert meta["clicked"] == [] and meta["iframes"] == 1  # what it could not read is said, not hidden


@pytest.mark.asyncio
async def test_the_saved_file_rebuilds_the_same_shadow_tree_when_loaded_again(site, tmp_path):
    from playwright.async_api import async_playwright

    result = await _capture(site, tmp_path, "/apply", controls_timeout_ms=5000)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()
        await page.goto(result.files["dom"].as_uri())
        in_shadow = await page.evaluate(
            "document.getElementById('host').shadowRoot !== null && "
            "document.getElementById('host').shadowRoot.querySelector('#first') !== null"
        )
        await browser.close()
    assert in_shadow


# -- what it does NOT do ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_without_click_nothing_is_clicked_typed_changed_or_submitted(site, tmp_path):
    await _capture(site, tmp_path, "/apply", controls_timeout_ms=5000)
    assert _touched(site) == []  # the page was loaded and read, and not touched
    assert site.posts == []
    assert [path for _method, path in site.seen].count("/apply") == 1  # one page, loaded once


@pytest.mark.asyncio
async def test_click_presses_the_one_named_button_and_nothing_else(site, tmp_path):
    result = await _capture(site, tmp_path, "/reveal", clicks=("Toon formulier",), controls_timeout_ms=5000)

    assert result.has_form and result.meta["clicked"] == ["Toon formulier"]
    assert _touched(site) == ["/log/click"]  # exactly one click, no key, no input, no submit


@pytest.mark.asyncio
async def test_a_click_text_matches_whatever_the_case_the_page_shows(site, tmp_path):
    result = await _capture(site, tmp_path, "/reveal", clicks=("TOON FORMULIER",), controls_timeout_ms=5000)
    assert result.has_form and _touched(site) == ["/log/click"]


@pytest.mark.parametrize(
    "text, why",
    [
        ("Continue", "submit"),   # type=submit in a form: its label says nothing, its type does
        ("Next", "submit"),       # a form's button without a type submits by default
        ("Expand", "submit"),     # a link-button inside a form: cannot tell what it does
        ("Go on", "submit"),      # a custom element inside a form: same
    ],
)
@pytest.mark.asyncio
async def test_a_control_that_would_submit_a_form_is_refused_whatever_it_says(site, tmp_path, text, why):
    with pytest.raises(tool.ClickRefused, match="would submit a form"):
        await _capture(site, tmp_path, "/guard", clicks=(text,))
    assert _touched(site) == []
    assert not list(tmp_path.iterdir())  # nothing was written for a capture that was refused


@pytest.mark.parametrize("text", ["More options", "Show more"])
@pytest.mark.asyncio
async def test_a_plain_button_is_clicked_even_inside_a_form(site, tmp_path, text):
    # type=button inside a form submits nothing; outside any form there is nothing to submit.
    result = await _capture(site, tmp_path, "/guard", clicks=(text,))
    assert result.meta["clicked"] == [text] and _touched(site) == ["/log/click"]


@pytest.mark.asyncio
async def test_two_buttons_with_the_same_text_are_not_guessed_between(site, tmp_path):
    with pytest.raises(tool.CaptureError, match="matches 2 buttons"):
        await _capture(site, tmp_path, "/guard", clicks=("Same",))
    assert _touched(site) == []


@pytest.mark.asyncio
async def test_a_click_text_that_is_not_on_the_page_lists_what_is(site, tmp_path):
    with pytest.raises(tool.CaptureError) as err:
        await _capture(site, tmp_path, "/guard", clicks=("Nothing like this",))
    assert "Show more" in str(err.value) and "Continue" in str(err.value)
    assert _touched(site) == []


# -- the words, and the command line ----------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "Submit", "SUBMIT & NEXT", "Submit application", "Verzenden", "Versturen", "Verstuur", "Send application",
        "Apply now", "  apply   NOW ", "Solliciteer", "Solliciteer nu", "Solliciteren", "Sollicitatie versturen",
    ],
)
def test_a_click_that_looks_like_sending_an_application_is_refused(text):
    assert tool.refused_click(text) is not None


@pytest.mark.parametrize("text", ["Toon formulier", "I'm interested", "Show more", "Volgende", "Apply", "Meer opties"])
def test_a_click_that_only_reveals_is_not_refused_by_its_words(text):
    assert tool.refused_click(text) is None


def test_a_refused_click_costs_nothing_not_even_a_page_load(site, tmp_path, capsys):
    code = tool.main([site.url("/apply"), "--out", str(tmp_path / "out"), "--click", "Submit application"])

    assert code == tool.EXIT_REFUSED
    assert "Refusing to click" in capsys.readouterr().err
    assert site.seen == []  # the browser never started
    assert not list(tmp_path.iterdir())


def test_the_command_line_writes_three_files_and_says_where(site, tmp_path, capsys):
    prefix = tmp_path / "captures" / "apply"
    code = tool.main([site.url("/apply"), "--out", str(prefix), "--wait", "5", "--locale", "nl-NL"])

    out = capsys.readouterr().out
    assert code == tool.EXIT_OK
    assert "Captured" in out and "controls" in out
    for suffix in ("dom.html", "controls.json", "meta.json"):
        assert (tmp_path / "captures" / f"apply.{suffix}").is_file()
        assert f"apply.{suffix}" in out


def test_a_page_without_a_form_is_still_saved_and_the_exit_code_says_so(site, tmp_path, capsys):
    code = tool.main([site.url("/noform"), "--out", str(tmp_path / "out"), "--wait", "0.3"])

    assert code == tool.EXIT_NO_FORM
    assert "no input, textarea or select was found" in capsys.readouterr().err
    assert (tmp_path / "out.dom.html").is_file()


def test_a_page_that_does_not_load_is_reported_not_crashed(tmp_path, capsys):
    code = tool.main(["http://127.0.0.1:1/", "--out", str(tmp_path / "out")])

    assert code == tool.EXIT_LOAD_FAILED
    assert "Could not load http://127.0.0.1:1/" in capsys.readouterr().err


def test_an_address_that_is_not_http_https_or_file_is_not_loaded(capsys):
    assert tool.main(["ftp://example.test/job"]) == tool.EXIT_REFUSED


def test_a_certificate_failure_is_explained_and_never_bypassed():
    message = tool._load_failure_message("https://x.test/", "net::ERR_CERT_AUTHORITY_INVALID at https://x.test/")
    assert "certificate" in message and "will not bypass" in message
    assert "ignore_https_errors" not in inspect.getsource(tool)  # no switch for it exists


# -- it only reads: pinned in the source ------------------------------------------------

#: Playwright calls that act on a page. The one `click` is the guarded one; nothing else may appear.
ACTING_CALLS = {
    "fill", "type", "press", "check", "uncheck", "set_checked", "set_input_files", "select_option",
    "dblclick", "tap", "hover", "focus", "dispatch_event", "submit", "request_submit", "drag_to",
}
#: What the page-side JavaScript must never contain: an action or an assignment to a control.
JS_ACTIONS = re.compile(
    r"\.click\s*\(|\.submit\s*\(|requestSubmit|dispatchEvent|\.focus\s*\(|\.blur\s*\(|\.value\s*=(?!=)|\.checked\s*=(?!=)|"
    r"\.innerHTML\s*=|\.textContent\s*=|\.setAttribute\s*\(|\.removeAttribute\s*\(|location\s*=|\.reset\s*\("
)


def _calls(source: str) -> list[tuple[str, str]]:
    """(attribute name, enclosing function) for every `x.name(...)` call."""
    found: list[tuple[str, str]] = []
    tree = ast.parse(source)

    def visit(node, function):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            function = node.name
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            found.append((node.func.attr, function))
        for child in ast.iter_child_nodes(node):
            visit(child, function)

    visit(tree, "<module>")
    return found


def test_the_tool_can_act_on_a_page_in_exactly_one_place():
    calls = _calls(inspect.getsource(tool))
    assert [(name, fn) for name, fn in calls if name in ACTING_CALLS] == []
    assert [fn for name, fn in calls if name == "click"] == ["_click_by_text"]


def test_the_one_click_is_checked_for_submitting_before_it_is_made():
    source = inspect.getsource(tool._click_by_text)
    assert source.index("SUBMIT_LIKE_JS") < source.index(".click(")


def test_the_page_side_javascript_only_reads():
    scripts = {
        name: getattr(tool, name)
        for name in ("FLATTEN_JS", "CONTROLS_JS", "UNREADABLE_JS", "SUBMIT_LIKE_JS", "CLICKABLES_JS")
    }
    assert {name for name, js in scripts.items() if JS_ACTIONS.search(js)} == set()


def test_the_scans_would_notice_a_click_a_keypress_and_a_script_that_types():
    bad = """
async def helper(page):
    await page.get_by_role("button").click()
    await page.keyboard.press("Enter")
    await page.fill("#x", "y")
"""
    names = {(name, fn) for name, fn in _calls(bad)}
    assert ("click", "helper") in names and ("press", "helper") in names and ("fill", "helper") in names
    assert JS_ACTIONS.search("document.querySelector('input').value = 'x'")
    assert JS_ACTIONS.search("el.click()")
    assert not JS_ACTIONS.search("if (a.value == b) return el.checked === true")
