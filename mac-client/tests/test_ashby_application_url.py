"""ashby_application_url — pure function, no browser needed.

Found live, 2026-08-25: process_job() navigated straight to a real Ashby
posting's base URL, which has zero <input> elements — every one of ASHBY's
field-map selectors in adapters.py then timed out for a page that never had a
form on it, not because the selectors were wrong (they were verified correct
against the same live posting). Same root cause and fix as the VPS TypeScript
pipeline's ashbyApplicationUrl in apply-driver.ts (2026-08-24/25); this Python
implementation is a separate codebase that never got the port.

Kept in its own module rather than test_apply_browser.py: that file sets a
module-level `pytestmark = pytest.mark.asyncio` for its Playwright-driven
tests, which pytest-asyncio then (incorrectly) tries to apply to any plain
sync function defined in the same file too.
"""

from mac_client.apply import ashby_application_url


def test_appends_the_application_path():
    assert (
        ashby_application_url("https://jobs.ashbyhq.com/altura/d73e7e22-d03f-4b4d-886a-9ec837ab4b62")
        == "https://jobs.ashbyhq.com/altura/d73e7e22-d03f-4b4d-886a-9ec837ab4b62/application"
    )


def test_is_idempotent_if_already_present():
    already = "https://jobs.ashbyhq.com/altura/d73e7e22-d03f-4b4d-886a-9ec837ab4b62/application"
    assert ashby_application_url(already) == already


def test_strips_a_trailing_slash_first():
    assert (
        ashby_application_url("https://jobs.ashbyhq.com/altura/abc123/")
        == "https://jobs.ashbyhq.com/altura/abc123/application"
    )


def test_preserves_query_and_fragment():
    assert (
        ashby_application_url("https://jobs.ashbyhq.com/altura/abc123?ref=li#top")
        == "https://jobs.ashbyhq.com/altura/abc123/application?ref=li#top"
    )
