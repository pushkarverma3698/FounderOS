"""Dutch form labels (A4): the resolver reads them, and never guesses.

THE FAILURE THIS GUARDS AGAINST. Most Dutch finance postings are written in
Dutch, and their forms are labelled in Dutch: "Voornaam", "E-mailadres",
"Telefoonnummer". The resolver only knew the English words, so on such a form
it found nothing and left every field for her to type. The opposite failure is
worse: a loose Dutch word ("naam" is inside "voornaam", "achternaam",
"bedrijfsnaam" and "gebruikersnaam") would type her full name into a company
box. So the table below pins both directions, against the resolver's real
JavaScript running in a real browser, over local HTML only ($0, no network).

Two rules under test:
  * a Dutch label and its English twin resolve to the SAME field;
  * a label we do not know stays unresolved.
"""

from __future__ import annotations

import html
from types import SimpleNamespace

import pytest
import pytest_asyncio

from mac_client import resolver

MODULE_LOOP = {"loop_scope": "module"}


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def page():
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context()
        yield await context.new_page()
        await browser.close()


async def resolve(page, label: str, kind: str = "text") -> set[str]:
    """Which fields the resolver assigns to ONE input carrying this label."""
    control = '<textarea id="f"></textarea>' if kind == "textarea" else f'<input id="f" type="{kind}">'
    await page.set_content(
        f'<!doctype html><html><body><label for="f">{html.escape(label)}</label>{control}</body></html>'
    )
    return set(await page.evaluate(resolver.RESOLVER_JS))


# (label as printed on the form, control, the fields it resolves to).
# An empty set means "unresolved: the founder fills it".
LABELS = [
    # -- first / last / full name -------------------------------------------
    ("First name", "text", {"first_name"}),
    ("Voornaam", "text", {"first_name"}),
    ("Last name", "text", {"last_name"}),
    ("Achternaam", "text", {"last_name"}),
    ("Familienaam", "text", {"last_name"}),
    ("Full name", "text", {"full_name"}),
    ("Volledige naam", "text", {"full_name"}),
    ("Uw naam", "text", {"full_name"}),
    # -- email ----------------------------------------------------------------
    ("Email", "text", {"email"}),
    ("E-mailadres", "text", {"email"}),
    ("E-mail", "text", {"email"}),
    ("Emailadres", "text", {"email"}),
    ("Mailadres", "text", {"email"}),
    # -- phone ----------------------------------------------------------------
    ("Phone", "text", {"phone"}),
    ("Mobile number", "text", {"phone"}),
    ("Telefoonnummer", "text", {"phone"}),
    ("Telefoon", "text", {"phone"}),
    ("Mobiel nummer", "text", {"phone"}),
    ("Mobiel telefoonnummer", "text", {"phone"}),
    # -- resume ("cv" is the same word in both languages: one field, one fill) --
    ("Resume", "file", {"resume"}),
    ("CV", "file", {"resume"}),
    ("Curriculum vitae", "file", {"resume"}),
    ("CV uploaden", "file", {"resume"}),
    # -- cover letter: recognised so it is NEVER taken for the resume ----------
    ("Cover letter", "file", {"cover_letter"}),
    ("Motivatiebrief", "file", {"cover_letter"}),
    ("Begeleidende brief", "file", {"cover_letter"}),
    ("Sollicitatiebrief", "file", {"cover_letter"}),
    ("Cover letter", "textarea", {"cover_letter"}),
    ("Motivatiebrief", "textarea", {"cover_letter"}),
    # One dropzone for both: it is still where the CV goes.
    ("CV en motivatiebrief", "file", {"resume", "cover_letter"}),
    # -- unknown Dutch labels stay unresolved. Each one contains a word that a
    # -- careless term would match, which is why it is here. -------------------
    ("Naam", "text", set()),
    ("Bedrijfsnaam", "text", set()),
    ("Gebruikersnaam", "text", set()),
    ("Tussenvoegsel", "text", set()),
    ("Voorletters", "text", set()),
    ("Geboortedatum", "text", set()),
    ("Woonplaats", "text", set()),
    ("Salarisverwachting", "text", set()),
    ("Opmerkingen", "text", set()),
    ("Hoe heb je ons gevonden?", "text", set()),
]


def _row_id(row) -> str:
    label, kind, _ = row
    return f"{label} ({kind})"


@pytest.mark.asyncio(**MODULE_LOOP)
@pytest.mark.parametrize("row", LABELS, ids=_row_id)
async def test_each_label_resolves_to_exactly_its_field(page, row):
    label, kind, expected = row
    assert await resolve(page, label, kind) == expected


# (Dutch label, English twin, control): the same field both ways.
TWINS = [
    ("Voornaam", "First name", "text"),
    ("Achternaam", "Last name", "text"),
    ("Volledige naam", "Full name", "text"),
    ("E-mailadres", "Email", "text"),
    ("Telefoonnummer", "Phone", "text"),
    ("Mobiel nummer", "Mobile number", "text"),
    ("CV", "Resume", "file"),
    ("Curriculum vitae", "Resume", "file"),
    ("Motivatiebrief", "Cover letter", "file"),
    ("Begeleidende brief", "Cover letter", "textarea"),
]


@pytest.mark.asyncio(**MODULE_LOOP)
@pytest.mark.parametrize("twins", TWINS, ids=lambda t: f"{t[0]} = {t[1]}")
async def test_a_dutch_label_and_its_english_twin_are_the_same_field(page, twins):
    dutch, english, kind = twins
    dutch_fields = await resolve(page, dutch, kind)
    assert dutch_fields, f"{dutch!r} resolved to nothing"
    assert dutch_fields == await resolve(page, english, kind)


# -- the whole plan, on a Dutch form ---------------------------------------------

DUTCH_FORM = """<!doctype html><html><body><form>
  <label for="v">Voornaam</label><input id="v" type="text">
  <label for="a">Achternaam</label><input id="a" type="text">
  <label for="m">E-mailadres</label><input id="m" type="text">
  <label for="t">Telefoonnummer</label><input id="t" type="text">
  <label for="c">CV uploaden</label><input id="c" type="file">
  <label for="b">Motivatiebrief</label><textarea id="b"></textarea>
</form></body></html>"""

PROFILE = SimpleNamespace(
    first_name="Tashi", last_name="Sharma", email="t@example.com", phone="+31600000001",
    linkedin=None, website=None,
)


@pytest.mark.asyncio(**MODULE_LOOP)
async def test_a_dutch_form_gets_the_identity_fields_and_never_a_cover_letter(page):
    await page.set_content(DUTCH_FORM)
    plan, resume_selector = await resolver.resolve_fallback_fields(page, PROFILE, [])

    assert {label: value for label, _sel, value in plan} == {
        "first name": "Tashi",
        "last name": "Sharma",
        "email": "t@example.com",
        "phone": "+31600000001",
    }
    # One selector per field: no element is filled twice.
    selectors = [sel for _label, sels, _value in plan for sel in sels]
    assert len(selectors) == len(set(selectors))
    # The CV goes into the CV box, not the cover letter's.
    assert await page.locator(resume_selector).get_attribute("id") == "c"


# -- the vocabulary itself, no browser -----------------------------------------------


def test_no_term_belongs_to_two_fields_or_sits_inside_another_fields_term():
    # The double-fill guard. If a term of one field were part of another
    # field's term, a label carrying the longer one would resolve to BOTH
    # fields and the second fill would overwrite the first in the same input.
    rules = resolver.FIELD_RULES
    for key, rule in rules.items():
        for term in rule["terms"]:
            for other_key, other in rules.items():
                if other_key == key:
                    continue
                for other_term in other["terms"]:
                    assert term not in other_term, (
                        f"{key!r} term {term!r} is inside {other_key!r} term {other_term!r}"
                    )


def test_every_term_is_lowercase_because_the_page_text_is_lowercased_first():
    for key, rule in resolver.FIELD_RULES.items():
        for term in rule["terms"]:
            assert term == term.lower(), f"{key!r} term {term!r} could never match"


def test_no_field_matches_on_a_bare_word_that_lives_inside_other_labels():
    # "naam" is inside voornaam / achternaam / bedrijfsnaam / gebruikersnaam.
    banned = {"naam", "name", "nummer", "number", "brief", "letter", "mail"}
    for key, rule in resolver.FIELD_RULES.items():
        assert banned.isdisjoint(rule["terms"]), f"{key!r} has a bare ambiguous term"
