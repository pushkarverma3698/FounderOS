"""Which fields we are willing to fill, and which we refuse to guess.

THE LINE THIS DEFENDS. Filling name, email, phone and a resume saves the founder
typing he would do identically every time. Filling a work-authorisation or
"why do you want to work here" field would make a claim on his behalf that he
never read — so those are left blank, and the overlay says so.
"""

from __future__ import annotations

from mac_client.adapters import FIELD_MAPS, ats_for_url, field_map_for, planned_fills
from mac_client.profile import ApplyProfile

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
