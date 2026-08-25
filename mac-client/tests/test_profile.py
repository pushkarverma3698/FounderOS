"""The preflight that stops a dummy resume reaching a real employer.

THE FAILURE THIS GUARDS AGAINST. The prototype wrote the literal string "This is
a dummy resume for testing purposes." into a file called ``dummy_resume.pdf``
and uploaded it. Every check here exists so the queue refuses to start rather
than send that, or a blank, or another track's CV.
"""

from __future__ import annotations

import json

import pytest

from mac_client.profile import ApplyProfile, ProfileError, load_profile, missing_resumes, resume_unusable
from mac_client.sync import QueueJob

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


def test_missing_resumes_flags_a_tailored_cv_that_never_arrived(tmp_path):
    # THE SILENT SUBSTITUTION. A generic resume IS on disk, so the naive check
    # ("is there a file?") says everything is fine — but this row was promised
    # a tailored CV (tailored_cv_s3_key is set) and the S3 fetch either never
    # ran or failed. That must be reported, not silently absorbed by the
    # generic fallback. job_id is a fresh id with no .queue/ dir on disk, which
    # IS the "the fetch never landed" state — no mocking needed.
    cv = tmp_path / "generic.pdf"
    cv.write_bytes(b"%PDF-1.4 real enough")
    path = write(tmp_path, {**VALID, "default_resume": str(cv)})
    profile = load_profile(path)
    job = QueueJob(
        id="t1b-missing-00000000-0000-0000-0000-000000000001",
        company="Ockto",
        title="Senior Backend Engineer",
        track="ai",
        url="https://ockto.recruitee.com/o/senior-backend",
        brief_rank=1,
        tailored_cv_s3_key="tailored/ockto-senior-backend.pdf",
    )
    problems = missing_resumes(profile, [job])
    assert len(problems) == 1
    assert "Ockto" in problems[0]
    assert "tailored" in problems[0].lower()


def test_missing_resumes_is_quiet_when_the_row_never_had_a_tailored_cv(tmp_path):
    # Must not regress: a row with no tailored_cv_s3_key at all (never
    # queued for tailoring) is correctly served by the generic resume, and
    # that is not a problem worth reporting.
    cv = tmp_path / "generic.pdf"
    cv.write_bytes(b"%PDF-1.4 real enough")
    path = write(tmp_path, {**VALID, "default_resume": str(cv)})
    profile = load_profile(path)
    job = QueueJob(
        id="t1b-no-tailoring-00000000-0000-0000-0000-000000000002",
        company="Mollie",
        title="Backend Engineer",
        track="ai",
        url="https://jobs.lever.co/mollie/abc",
        brief_rank=2,
        tailored_cv_s3_key=None,
    )
    assert missing_resumes(profile, [job]) == []


def test_uses_tailored_cv_is_false_for_a_row_that_was_never_tailored(tmp_path):
    # QA, 2026-08-25: the FIRST version of this fix only warned when a tailored
    # CV was promised (tailored_cv_s3_key set) and then missing. Measured
    # against the real queue that covered 4 rows out of 62 — the other 58 had
    # never been tailored at all, uploaded the generic CV, and the overlay said
    # NOTHING. That is the same silent substitution T1b exists to stop, just in
    # a different shape: what the founder needs to know at SUBMIT time is
    # "is this the tailored CV or not", regardless of why.
    cv = tmp_path / "generic.pdf"
    cv.write_bytes(b"%PDF-1.4 real enough")
    path = write(tmp_path, {**VALID, "default_resume": str(cv)})
    profile = load_profile(path)
    job = QueueJob(
        id="qa-never-tailored-0000-0000-0000-000000000004",
        company="Visa", title="Software Engineer", track="ai",
        url="https://x", brief_rank=1, tailored_cv_s3_key=None,
    )
    # Not a "problem" (nothing is broken), but it IS a generic CV and the
    # overlay must be able to say so.
    assert profile.tailored_cv_missing(job) is False
    assert profile.uses_tailored_cv(job) is False


def test_resume_unusable_is_true_with_no_candidate_at_all():
    # Bypass load_profile's own "no resume at all" refusal by constructing the
    # dataclass directly — this test is about resume_unusable, not load_profile.
    profile = ApplyProfile(**{**VALID, "resumes": {}, "default_resume": None,
                               "linkedin": None, "website": None})
    job = QueueJob(id="x", company="Acme", title="Eng", track="ai", url="https://x", brief_rank=1)
    assert resume_unusable(profile, job) is True


def test_resume_unusable_is_true_when_the_configured_file_is_absent(tmp_path):
    path = write(tmp_path, {**VALID, "default_resume": str(tmp_path / "gone.pdf")})
    profile = load_profile(path)
    job = QueueJob(id="x", company="Acme", title="Eng", track="ai", url="https://x", brief_rank=1)
    assert resume_unusable(profile, job) is True


def test_resume_unusable_is_false_when_only_the_tailored_one_is_missing(tmp_path):
    # This is the queue-filter side of the T1b fix: a row that fell back to a
    # REAL generic PDF must stay in today's queue — missing_resumes() still
    # reports it (tested above), but resume_unusable() must not, or the job
    # would be silently dropped instead of silently mis-sent, trading one
    # silent failure for another.
    cv = tmp_path / "generic.pdf"
    cv.write_bytes(b"%PDF-1.4 real enough")
    path = write(tmp_path, {**VALID, "default_resume": str(cv)})
    profile = load_profile(path)
    job = QueueJob(
        id="t1b-unusable-check-00000000-0000-0000-0000-000000000003",
        company="Booking",
        title="Engineer",
        track="ai",
        url="https://x",
        brief_rank=3,
        tailored_cv_s3_key="tailored/booking.pdf",
    )
    assert resume_unusable(profile, job) is False
