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

import re
from dataclasses import dataclass

#: Which ATS a posting URL belongs to. Ordered so the first match wins.
_HOST_MARKERS = (
    ("greenhouse", ("greenhouse.io", "boards.greenhouse.io", "job-boards.greenhouse.io")),
    ("lever", ("lever.co", "jobs.lever.co")),
    ("ashby", ("ashbyhq.com", "jobs.ashbyhq.com")),
    ("workable", ("workable.com", "apply.workable.com")),
    ("recruitee", ("recruitee.com",)),
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

# Selectors are live-captured, not guessed: tests/fixtures/apply-forms/
# workable-gresb.json (apply.workable.com/gresb, 2026-08-24). That form also
# has a cover-letter textarea, two work-authorisation radio groups and a GDPR
# checkbox — deliberately absent below, same discipline as every other map
# here (see test_no_adapter_offers_to_fill_a_free_text_or_authorisation_field).
WORKABLE = FieldMap(
    first_name=("#firstname",),
    last_name=("#lastname",),
    email=("#email", 'input[type="email"]'),
    phone=('input[name="phone"]', 'input[type="tel"]'),
    resume=('input[name="resume"]', 'input[type="file"]'),
)

# Recruitee asks for ONE name field, like Lever. Selectors are live-captured:
# tests/fixtures/apply-forms/recruitee-ockto.json (ockto.recruitee.com,
# 2026-08-24) — a Dutch IND-recognised sponsor board (per the sponsor-registry
# join, 2026-08-20). That form also has a photo upload and an optional
# cover-letter file input — left unfilled, same as every other map here.
RECRUITEE = FieldMap(
    full_name=('input[name="candidate.name"]',),
    email=('input[name="candidate.email"]', 'input[type="email"]'),
    phone=('input[name="candidate.phone"]', 'input[type="tel"]'),
    resume=('input[name="candidate.cv"]', 'input[type="file"]'),
)

FIELD_MAPS = {
    "greenhouse": GREENHOUSE,
    "lever": LEVER,
    "ashby": ASHBY,
    "workable": WORKABLE,
    "recruitee": RECRUITEE,
}


def field_map_for(url: str) -> FieldMap | None:
    """The map for this posting's platform, or None when unrecognised."""
    ats = ats_for_url(url)
    return FIELD_MAPS.get(ats) if ats else None


# ---------------------------------------------------------------------------
# Where the application form lives.
#
# A posting URL is not always the form: Lever, Ashby, Workable, Recruitee,
# Workday and Teamtailor serve the form from a route of its own, and Greenhouse
# from an in-page anchor. Opening the posting instead costs Tashi a click on
# every row, and on Ashby it costs the whole fill (the posting page has no
# <input> at all, found live 2026-08-25).
#
# These are the rules of src/tools/jobhunt/adapters/*.ts (`applyUrlFor`, reached
# through `getApplyUrl` in apply-packet.ts), ported. The two are separate code,
# so tests/fixtures/apply-url-cases.json holds the (posting URL -> apply URL)
# cases and BOTH suites read it: change a rule on one side alone and the other
# side's test goes red. Deliberate difference: a `?query` or `#fragment` stays
# after the path here, where the TypeScript appends its suffix after it.
# ---------------------------------------------------------------------------

#: Same recognisers, in the same order, as `PATTERNS` in
#: src/tools/jobhunt/board-token.ts. Strict on purpose, unlike `ats_for_url`
#: above: a custom domain that merely fronts a platform (Databricks'
#: `?gh_jid=`) carries no board, and guessing "+/apply" on it makes a link that
#: looks authoritative and 404s.
_APPLY_PLATFORM_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = tuple(
    (name, re.compile(pattern, re.IGNORECASE))
    for name, pattern in (
        ("greenhouse", r"^https?://(?:job-)?boards(?:\.eu)?\.greenhouse\.io/([^/?#]+)"),
        ("lever", r"^https?://jobs(?:\.eu)?\.lever\.co/([^/?#]+)"),
        ("ashby", r"^https?://jobs\.ashbyhq\.com/([^/?#]+)"),
        ("recruitee", r"^https?://([a-z0-9-]+)\.recruitee\.com(?:/|$|\?)"),
        ("smartrecruiters", r"^https?://jobs\.smartrecruiters\.com/([^/?#]+)"),
        # `/j/` is required: without it the capture takes the literal "j".
        ("workable", r"^https?://apply\.workable\.com/([^/?#]+)/j/"),
        # `jobs.` is excluded: the bare marketing host is not a customer board.
        ("personio", r"^https?://(?!jobs\.)([a-z0-9-]+)\.jobs\.personio\.(?:com|de)(?:/|$|\?)"),
        (
            "workday",
            r"^https?://([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com/(?:wday/cxs/[^/]+/)?(?:[a-z]{2}-[a-z]{2}/)?([^/?#]+)",
        ),
        # `www` and `app` are the platform's own sites, never a customer board.
        ("teamtailor", r"^https?://(?!www\.|app\.)([a-z0-9-]+)\.teamtailor\.com(?:/|$|\?)"),
        (
            "bamboohr",
            r"^https?://(?!www\.|app\.)([a-z0-9-]+)\.bamboohr\.com/(?:careers|jobs|hiring)(?:/|$|\?)",
        ),
    )
)

#: Every platform `apply_url_for` has a rule for. The shared cases file must
#: name each one, and every platform it names must be in here.
APPLY_URL_PLATFORMS: tuple[str, ...] = tuple(name for name, _ in _APPLY_PLATFORM_PATTERNS)

#: Workable's widget API hands postings out as account-less short links and
#: names `<link>/apply` as the form in its own `application_url` field. There is
#: no account in the path, so no pattern above sees them.
_WORKABLE_SHORT_LINK = re.compile(r"^https?://apply\.workable\.com/j/[a-z0-9]+(?:/apply)?/?$", re.IGNORECASE)

#: The path the form sits at, appended to the posting URL. A platform absent
#: here and not Greenhouse serves its form on the posting page itself
#: (SmartRecruiters, BambooHR, Personio), so the posting URL is the answer.
_APPLY_PATH_SUFFIX = {
    "lever": "/apply",
    "ashby": "/application",
    "recruitee": "/c/new",
    "workable": "/apply",
    "workday": "/apply",
    "teamtailor": "/applications/new",
}

#: Greenhouse's form is on the posting page; this anchor scrolls to it.
_GREENHOUSE_FORM_ANCHOR = "#app"


def _split_tail(url: str) -> tuple[str, str, str]:
    """(head, "?query" or "", "#fragment" or ""). String-level, so nothing else
    in the URL is re-serialised: no case folding, no port or escape rewriting."""
    head, hash_mark, fragment = url.partition("#")
    head, question_mark, query = head.partition("?")
    return head, question_mark + query, hash_mark + fragment


def append_path_suffix(url: str, suffix: str) -> str:
    """The URL with `suffix` at the end of its path, unless it is already there.

    Trailing slashes on the path are dropped first, and a `?query` / `#fragment`
    is kept after the path, so `.../abc?ref=x` becomes `.../abc/apply?ref=x`.
    """
    head, query, fragment = _split_tail(url)
    head = head.rstrip("/")
    if suffix and not head.endswith(suffix):
        head += suffix
    return head + query + fragment


def _apply_platform_of(url: str) -> str | None:
    for name, pattern in _APPLY_PLATFORM_PATTERNS:
        if pattern.match(url):
            return name
    return None


def apply_url_for(url: str | None) -> str | None:
    """The address of this posting's application form, or None when we cannot
    say. None is a first-class answer: the caller opens the posting URL itself,
    and the founder finds the form by hand.

    Total: never raises on junk. Idempotent: an apply URL maps to itself.
    """
    if not isinstance(url, str) or not url.strip():
        return None
    if _WORKABLE_SHORT_LINK.match(url):
        return append_path_suffix(url, "/apply")

    platform = _apply_platform_of(url)
    if platform is None:
        return None
    if platform == "greenhouse":
        head, query, fragment = _split_tail(url)
        if fragment == _GREENHOUSE_FORM_ANCHOR:
            return url
        return head.rstrip("/") + query + _GREENHOUSE_FORM_ANCHOR
    return append_path_suffix(url, _APPLY_PATH_SUFFIX.get(platform, ""))


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

