"""Which fields we are willing to fill, and which we refuse to guess.

THE LINE THIS DEFENDS. Filling name, email, phone and a resume saves the founder
typing he would do identically every time. Filling a work-authorisation or
"why do you want to work here" field would make a claim on his behalf that he
never read — so those are left blank, and the overlay says so.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from mac_client import apply as apply_mod
from mac_client.adapters import (
    APPLY_URL_PLATFORMS,
    FIELD_MAPS,
    apply_url_for,
    ats_for_url,
    field_map_for,
    planned_fills,
)
from mac_client.profile import ApplyProfile
from mac_client.sync import QueueJob

PROFILE = ApplyProfile(
    first_name="Pushkar",
    last_name="Verma",
    email="p@example.com",
    phone="+31600000000",
    resumes={},
    default_resume="/cv.pdf",
)


def test_recognises_each_supported_platform():
    assert ats_for_url("https://boards.greenhouse.io/aquablu/jobs/1") == "greenhouse"
    assert ats_for_url("https://job-boards.greenhouse.io/x/jobs/2") == "greenhouse"
    assert ats_for_url("https://jobs.lever.co/mollie/abc") == "lever"
    assert ats_for_url("https://jobs.ashbyhq.com/altura/xyz") == "ashby"
    # T4, 2026-08-25: any Workable/Recruitee posting used to reach the founder's
    # queue with ats_for_url() returning None — a blank form, no autofill at all,
    # even though the VPS side has scraped both platforms all along.
    assert ats_for_url("https://apply.workable.com/gresb/j/A5B057E570/apply/") == "workable"
    assert ats_for_url("https://ockto.recruitee.com/o/senior-site-reliability-engineer") == "recruitee"


def test_an_unknown_host_returns_none_rather_than_a_guess():
    # Guessing a field map for an unknown platform is how a phone number lands
    # in a salary box. None means "the founder fills this one by hand".
    assert ats_for_url("https://careers.example.com/apply/1") is None
    assert field_map_for("https://careers.example.com/apply/1") is None


def test_empty_and_malformed_urls_do_not_raise():
    assert ats_for_url("") is None
    assert ats_for_url(None) is None


def test_lever_gets_one_name_field_not_two():
    # Lever asks for a single "name". Filling first and last separately would
    # leave the surname in a box that does not exist and the form half-done.
    labels = [label for label, _, _ in planned_fills(FIELD_MAPS["lever"], PROFILE)]
    assert "name" in labels
    assert "first name" not in labels


def test_greenhouse_gets_split_name_fields():
    labels = [label for label, _, _ in planned_fills(FIELD_MAPS["greenhouse"], PROFILE)]
    assert "first name" in labels and "last name" in labels
    assert "name" not in labels


def test_the_plan_carries_the_real_values():
    plan = dict((label, value) for label, _, value in planned_fills(FIELD_MAPS["greenhouse"], PROFILE))
    assert plan["email"] == "p@example.com"
    assert plan["first name"] == "Pushkar"


def test_workable_gets_split_name_fields():
    # tests/fixtures/apply-forms/workable-gresb.json: #firstname / #lastname,
    # two separate fields — same shape as Greenhouse, not Lever's single name.
    labels = [label for label, _, _ in planned_fills(FIELD_MAPS["workable"], PROFILE)]
    assert "first name" in labels and "last name" in labels
    assert "name" not in labels


def test_recruitee_gets_one_name_field_not_two():
    # tests/fixtures/apply-forms/recruitee-ockto.json: input[name="candidate.name"],
    # one field — same shape as Lever, filling first/last separately would leave
    # the surname in a box that does not exist.
    labels = [label for label, _, _ in planned_fills(FIELD_MAPS["recruitee"], PROFILE)]
    assert "name" in labels
    assert "first name" not in labels


def test_workable_and_recruitee_plans_carry_the_real_values():
    workable_plan = dict((label, value) for label, _, value in planned_fills(FIELD_MAPS["workable"], PROFILE))
    assert workable_plan["email"] == "p@example.com"
    assert workable_plan["first name"] == "Pushkar"

    recruitee_plan = dict((label, value) for label, _, value in planned_fills(FIELD_MAPS["recruitee"], PROFILE))
    assert recruitee_plan["email"] == "p@example.com"
    assert recruitee_plan["name"] == "Pushkar Verma"


def test_no_adapter_offers_to_fill_a_free_text_or_authorisation_field():
    # The union of every selector we will ever type into. If a future edit adds
    # a cover-letter or visa-status field, this test is what catches it.
    forbidden = ("cover", "letter", "authorization", "authorisation", "visa",
                 "sponsor", "salary", "why", "gender", "race", "veteran")
    for name, field_map in FIELD_MAPS.items():
        selectors = " ".join(
            " ".join(group)
            for group in (
                field_map.first_name, field_map.last_name, field_map.full_name,
                field_map.email, field_map.phone, field_map.resume,
            )
        ).lower()
        for word in forbidden:
            assert word not in selectors, f"{name} would fill a {word} field"


# --------------------------------------------------------------------------
# Where the form lives (A2). The rules are the TypeScript `applyUrlFor`s in
# src/tools/jobhunt/adapters/*.ts, ported. tests/unit/jobhunt/apply-url.test.ts
# reads the SAME cases file, so a rule changed on one side alone fails the other.
# --------------------------------------------------------------------------

SHARED_CASES_PATH = Path(__file__).parent / "fixtures" / "apply-url-cases.json"
SHARED_CASES = json.loads(SHARED_CASES_PATH.read_text())["cases"]


def _case_id(case: dict) -> str:
    return f"{case['platform'] or 'unrecognised'}: {case['name']}"


@pytest.mark.parametrize("case", SHARED_CASES, ids=_case_id)
def test_apply_url_matches_the_shared_cases(case):
    assert apply_url_for(case["posting_url"]) == case["apply_url"]


def test_the_shared_cases_cover_every_platform_python_knows():
    covered = {c["platform"] for c in SHARED_CASES}
    assert sorted(set(APPLY_URL_PLATFORMS) - covered) == []


def test_python_knows_every_platform_the_shared_cases_name():
    # A platform added to the TypeScript registry and the cases file, and not
    # here, would leave the Mac client opening its posting page for ever.
    named = {c["platform"] for c in SHARED_CASES if c["platform"]}
    assert sorted(named - set(APPLY_URL_PLATFORMS)) == []


def test_an_unrecognised_url_yields_none_so_the_caller_keeps_the_posting_url():
    assert apply_url_for("https://careers.example.com/apply/1") is None
    assert apply_url_for("") is None
    assert apply_url_for(None) is None


@pytest.mark.parametrize(
    "posting, expected",
    [
        ("https://jobs.lever.co/acme/abc-123?lever-source=x", "https://jobs.lever.co/acme/abc-123/apply?lever-source=x"),
        ("https://jobs.ashbyhq.com/altura/abc123?ref=li#top", "https://jobs.ashbyhq.com/altura/abc123/application?ref=li#top"),
        ("https://ockto.recruitee.com/o/sre?ref=x", "https://ockto.recruitee.com/o/sre/c/new?ref=x"),
        ("https://job-boards.greenhouse.io/acme/jobs/1?gh_src=x", "https://job-boards.greenhouse.io/acme/jobs/1?gh_src=x#app"),
    ],
)
def test_a_query_or_fragment_stays_after_the_path(posting, expected):
    # Python only, on purpose. The TypeScript side appends its suffix after a
    # query string, which yields a link that 404s; posting URLs from the sweep
    # never carry one today, so the shared cases do not pin it.
    assert apply_url_for(posting) == expected


class _Navigated(Exception):
    """Raised by the fake page at its first navigation, carrying the URL."""


class _FakePage:
    async def goto(self, url, **_kwargs):
        raise _Navigated(url)


def _url_the_browser_opens(posting_url: str) -> str:
    job = QueueJob(
        id="00000000-0000-0000-0000-000000000001",
        company="Fixture BV",
        title="Financial Analyst",
        track="finance",
        url=posting_url,
        brief_rank=1,
    )
    with pytest.raises(_Navigated) as raised:
        asyncio.run(apply_mod.process_job(_FakePage(), job, PROFILE, "1 of 1"))
    return raised.value.args[0]


@pytest.mark.parametrize("case", SHARED_CASES, ids=_case_id)
def test_the_browser_opens_the_form_not_the_posting(case):
    # The wiring, not just the function: process_job is what navigates. Where no
    # rule applies it must fall back to the posting URL, never to nothing.
    expected = case["apply_url"] or case["posting_url"]
    assert _url_the_browser_opens(case["posting_url"]) == expected


def test_an_ashby_url_on_a_host_only_the_loose_match_knows_still_gets_the_application_route():
    # Before A2 every ashbyhq.com URL was sent to /application. The strict
    # recogniser only knows jobs.ashbyhq.com, so the loose one stays as a
    # fallback: no URL that worked yesterday opens the form-less page today.
    assert apply_url_for("https://ashbyhq.com/altura/abc123") is None
    assert _url_the_browser_opens("https://ashbyhq.com/altura/abc123") == "https://ashbyhq.com/altura/abc123/application"
