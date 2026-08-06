"""The preflight that stops a dummy resume reaching a real employer.

THE FAILURE THIS GUARDS AGAINST. The prototype wrote the literal string "This is
a dummy resume for testing purposes." into a file called ``dummy_resume.pdf``
and uploaded it. Every check here exists so the queue refuses to start rather
than send that, or a blank, or another track's CV.
"""

from __future__ import annotations

import json

import pytest

from mac_client.profile import ProfileError, load_profile, missing_resumes

VALID = {
    "first_name": "Pushkar",
    "last_name": "Verma",
    "email": "p@example.com",
    "phone": "+31600000000",
    "default_resume": "",
    "resumes": {},
}


def write(tmp_path, payload):
    path = tmp_path / "apply-profile.json"
    path.write_text(json.dumps(payload))
    return path


def test_missing_file_names_the_fix(tmp_path):
    with pytest.raises(ProfileError) as err:
        load_profile(tmp_path / "nope.json")
    assert "apply-profile.example.json" in str(err.value)


def test_invalid_json_is_reported_not_swallowed(tmp_path):
    path = tmp_path / "apply-profile.json"
    path.write_text("{not json")
    with pytest.raises(ProfileError) as err:
        load_profile(path)
    assert "not valid JSON" in str(err.value)


def test_all_missing_identity_fields_are_reported_together(tmp_path):
    # One per run would mean four runs to fix four fields.
    path = write(tmp_path, {**VALID, "email": "", "phone": "  ", "default_resume": "/cv.pdf"})
    with pytest.raises(ProfileError) as err:
        load_profile(path)
    assert "email" in str(err.value) and "phone" in str(err.value)


def test_a_profile_with_no_resume_at_all_is_refused(tmp_path):
    path = write(tmp_path, VALID)
    with pytest.raises(ProfileError) as err:
        load_profile(path)
    assert "resume" in str(err.value)


def test_track_resume_wins_over_the_default(tmp_path):
    path = write(tmp_path, {**VALID, "default_resume": "/d.pdf", "resumes": {"ai": "/ai.pdf"}})
    profile = load_profile(path)
    assert profile.resume_for("ai") == "/ai.pdf"


def test_an_unknown_track_falls_back_to_the_default_not_another_track(tmp_path):
    # A frontend CV sent to an AI role is worse than the generic one: the
    # founder would not notice, and the employer reads it as considered.
    path = write(tmp_path, {**VALID, "default_resume": "/d.pdf", "resumes": {"frontend": "/fe.pdf"}})
    profile = load_profile(path)
    assert profile.resume_for("ai") == "/d.pdf"


def test_missing_resumes_reports_the_path_that_is_absent(tmp_path):
    path = write(tmp_path, {**VALID, "default_resume": str(tmp_path / "gone.pdf")})
    profile = load_profile(path)
    problems = missing_resumes(profile, ["ai", "backend"])
    assert len(problems) == 2
    assert "gone.pdf" in problems[0]


def test_missing_resumes_is_empty_when_every_file_exists(tmp_path):
    cv = tmp_path / "cv.pdf"
    cv.write_bytes(b"%PDF-1.4 real enough")
    path = write(tmp_path, {**VALID, "default_resume": str(cv)})
    profile = load_profile(path)
    assert missing_resumes(profile, ["ai", "backend"]) == []
