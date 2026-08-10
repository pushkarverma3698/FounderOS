"""Per-ATS form field maps.

Three platforms cover the whole registry (Greenhouse, Lever, Ashby), and each
names the same four fields differently. The selectors below are the union of the
naming schemes each platform has shipped, most specific first.

WHAT IS DELIBERATELY ABSENT: cover letters, "why do you want to work here",
work-authorisation questions, demographic questions, and every other custom
field. Those are left blank. A tool that types a plausible answer into a
work-authorisation question is not saving the founder time — it is making a
legal claim on his behalf that he never read.
"""

from __future__ import annotations

from dataclasses import dataclass

#: Which ATS a posting URL belongs to. Ordered so the first match wins.
_HOST_MARKERS = (
    ("greenhouse", ("greenhouse.io", "boards.greenhouse.io", "job-boards.greenhouse.io")),
    ("lever", ("lever.co", "jobs.lever.co")),
    ("ashby", ("ashbyhq.com", "jobs.ashbyhq.com")),
)


def ats_for_url(url: str) -> str | None:
    """Which platform this posting is on, or None when we do not recognise it.

    None is a first-class answer, not a failure: an unrecognised form still
    opens for the founder to fill by hand. Guessing a field map for an unknown
    platform is how a phone number lands in a salary box.
    """
    lowered = (url or "").lower()
    for ats, markers in _HOST_MARKERS:
        if any(marker in lowered for marker in markers):
            return ats
    return None


@dataclass(frozen=True)
class FieldMap:
    """CSS selectors for the fields we are willing to fill, by profile key."""

    first_name: tuple[str, ...] = ()
    last_name: tuple[str, ...] = ()
    full_name: tuple[str, ...] = ()
    email: tuple[str, ...] = ()
    phone: tuple[str, ...] = ()
    linkedin: tuple[str, ...] = ()
    website: tuple[str, ...] = ()
    resume: tuple[str, ...] = ('#resume', 'input[id="resume"]', 'input[aria-label*="Resume"]', 'input[aria-label*="CV"]', 'input[type="file"]')


GREENHOUSE = FieldMap(
    first_name=("#first_name", 'input[name="job_application[first_name]"]', 'input[autocomplete="given-name"]'),
    last_name=("#last_name", 'input[name="job_application[last_name]"]', 'input[autocomplete="family-name"]'),
    email=("#email", 'input[name="job_application[email]"]', 'input[type="email"]'),
    phone=("#phone", 'input[name="job_application[phone]"]', 'input[type="tel"]'),
    linkedin=('input[aria-label="LinkedIn Profile"]', 'input[name*="linkedin"]', 'input[id*="linkedin"]', 'input[aria-label*="LinkedIn" i]', 'input[placeholder*="LinkedIn" i]'),
    website=('input[aria-label="Website"]', 'input[name*="website"]', 'input[id*="website"]', 'input[aria-label*="Website" i]', 'input[placeholder*="Website" i]'),
    resume=('#resume', 'input[id="resume"]', 'input[type="file"]'),
)

# Lever asks for ONE name field. Filling first and last separately here would
# leave the surname in a box that does not exist and the form half-complete.
LEVER = FieldMap(
    full_name=('input[name="name"]', "#name"),
    email=('input[name="email"]', "#email", 'input[type="email"]'),
    phone=('input[name="phone"]', "#phone", 'input[type="tel"]'),
    linkedin=('input[name="urls[LinkedIn]"]', 'input[name*="linkedin"]'),
    website=('input[name="urls[Portfolio]"]', 'input[name="urls[Other]"]'),
    resume=('input[name="resume"]', 'input[type="file"]'),
)

ASHBY = FieldMap(
    first_name=('input[name="_systemfield_name.first"]',),
    last_name=('input[name="_systemfield_name.last"]',),
    full_name=('input[name="_systemfield_name"]', 'input[aria-label="Name"]'),
    email=('input[name="_systemfield_email"]', 'input[type="email"]'),
    phone=('input[name="_systemfield_phone"]', 'input[type="tel"]'),
    linkedin=('input[name*="linkedin"]', 'input[aria-label*="LinkedIn"]'),
    website=('input[name*="website"]', 'input[aria-label*="Website"]'),
    resume=('input[type="file"]',),
)

FIELD_MAPS = {"greenhouse": GREENHOUSE, "lever": LEVER, "ashby": ASHBY}


def field_map_for(url: str) -> FieldMap | None:
    """The map for this posting's platform, or None when unrecognised."""
    ats = ats_for_url(url)
    return FIELD_MAPS.get(ats) if ats else None


def planned_fills(field_map: FieldMap, profile) -> list[tuple[str, tuple[str, ...], str]]:
    """(label, selectors, value) for every field we intend to fill.

    Returned as data rather than executed here so the plan is testable without a
    browser, and so the overlay can tell the founder exactly what was filled —
    a form that was silently half-completed is one he will submit believing it
    was whole.
    """
    plan: list[tuple[str, tuple[str, ...], str]] = []
    if field_map.full_name:
        plan.append(("name", field_map.full_name, f"{profile.first_name} {profile.last_name}"))
    if field_map.first_name:
        plan.append(("first name", field_map.first_name, profile.first_name))
    if field_map.last_name:
        plan.append(("last name", field_map.last_name, profile.last_name))
    if field_map.email:
        plan.append(("email", field_map.email, profile.email))
    if field_map.phone:
        plan.append(("phone", field_map.phone, profile.phone))
    if field_map.linkedin and getattr(profile, "linkedin", None):
        plan.append(("linkedin", field_map.linkedin, profile.linkedin))
    if field_map.website and getattr(profile, "website", None):
        plan.append(("website", field_map.website, profile.website))
    return plan
