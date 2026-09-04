"""Who is applying, and with which resume.

NOTHING HERE IS INVENTED. Every value comes from ``apply-profile.json``, which
the founder fills in once and which is gitignored. A field he did not supply is
left blank on the form for him to complete during review — the alternative is a
tool that types a guessed answer into an employer's application, and a guessed
answer on a work-authorisation question is worse than an empty one.

The jolly-babbage prototype this replaces filled ``TestName`` /
``test@example.com`` and uploaded a text file named ``dummy_resume.pdf``. The
preflight below exists so that can never reach a real employer.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

DEFAULT_PROFILE_PATH = Path(__file__).resolve().parent.parent / "apply-profile.json"

#: Fields an ATS form always asks for. Missing ones are reported together rather
#: than one per run — a founder fixing his profile wants the whole list at once.
REQUIRED_FIELDS = ("first_name", "last_name", "email", "phone")


class ProfileError(RuntimeError):
    """The profile is missing or unusable. Always names the path and the fix."""


#: Which candidate this client applies for. Must match a JobSearchProfile id in
#: src/tools/jobhunt/profile-config.ts — it is what scopes the queue query, and a
#: mismatch silently pulls the OTHER candidate's rows and uploads this profile's
#: resume to them.
DEFAULT_PROFILE_ID = "pushkar-nl-tech"


@dataclass(frozen=True)
class ApplyProfile:
    first_name: str
    last_name: str
    email: str
    phone: str
    #: track -> absolute path of the resume PDF to upload for that track.
    resumes: dict[str, str]
    #: Used when a job's track has no entry of its own.
    default_resume: str | None
    linkedin: str | None = None
    website: str | None = None
    #: The job_applications.profile_id whose queue this client may act on.
    profile_id: str = DEFAULT_PROFILE_ID

    def resume_for(self, track: str, job_id: str | None = None) -> str | None:
        """The PDF for this track, or the default, or the per-job tailored PDF.

        Prefers a per-job tailored PDF from .queue/{job_id}/tailored_cv.pdf when present.
        """
        if job_id:
            queue_dir = Path(__file__).resolve().parent.parent / ".queue" / job_id
            tailored = queue_dir / "tailored_cv.pdf"
            if tailored.is_file():
                return str(tailored)
        return self.resumes.get(track) or self.default_resume

    def uses_tailored_cv(self, job) -> bool:
        """True when this job will upload its OWN tailored PDF.

        The question the founder actually needs answered at SUBMIT time is "is
        this the tailored CV, or the generic one" — which is NOT the same
        question as `tailored_cv_missing` below. A row that was never queued
        for tailoring at all is not a *fault*, but it still uploads the generic
        CV, and staying quiet about it is the same silent substitution T1b
        exists to stop. Measured against the real queue on 2026-08-25: 4 of 62
        rows carried a tailored CV; the other 58 fell back to generic with no
        warning shown anywhere.
        """
        job_id = getattr(job, "id", None)
        if not job_id:
            return False
        tailored = Path(__file__).resolve().parent.parent / ".queue" / job_id / "tailored_cv.pdf"
        return tailored.is_file()

    def tailored_cv_missing(self, job) -> bool:
        """True when this row was promised a tailored CV and it did not arrive.

        THE SILENT SUBSTITUTION this guards against: ``resume_for`` falls back to
        the generic resume whenever the tailored PDF is absent, and a generic
        resume passes every file-exists check — so a fetch that never ran or
        failed looked identical to a row that was never tailored at all. The
        difference is ``tailored_cv_s3_key``: a row with one was PROMISED a
        tailored CV; a row without one was never queued for tailoring, and the
        generic fallback for it is correct, not a problem.
        """
        s3_key = getattr(job, "tailored_cv_s3_key", None)
        if not s3_key:
            return False
        job_id = getattr(job, "id", None)
        if not job_id:
            return True
        tailored = Path(__file__).resolve().parent.parent / ".queue" / job_id / "tailored_cv.pdf"
        return not tailored.is_file()


def load_profile(path: Path = DEFAULT_PROFILE_PATH) -> ApplyProfile:
    """Read and validate the profile, or raise with the exact thing to fix."""
    if not path.exists():
        raise ProfileError(
            f"No apply profile at {path}.\n"
            f"Copy apply-profile.example.json to {path.name} and fill it in — "
            "the queue will not run without your real name, email and resume."
        )

    try:
        raw = json.loads(path.read_text())
    except json.JSONDecodeError as err:
        raise ProfileError(f"{path} is not valid JSON: {err}") from err

    missing = [f for f in REQUIRED_FIELDS if not str(raw.get(f, "")).strip()]
    if missing:
        raise ProfileError(f"{path} is missing: {', '.join(missing)}")

    resumes = {k: str(v) for k, v in (raw.get("resumes") or {}).items()}
    default_resume = raw.get("default_resume")

    if not resumes and not default_resume:
        raise ProfileError(
            f"{path} lists no resume. Set 'default_resume' to a PDF path, or "
            "'resumes' to a track -> PDF mapping."
        )

    return ApplyProfile(
        first_name=str(raw["first_name"]).strip(),
        last_name=str(raw["last_name"]).strip(),
        email=str(raw["email"]).strip(),
        phone=str(raw["phone"]).strip(),
        resumes=resumes,
        default_resume=str(default_resume) if default_resume else None,
        linkedin=raw.get("linkedin"),
        website=raw.get("website"),
        profile_id=str(raw.get("profile_id") or DEFAULT_PROFILE_ID).strip(),
    )


def missing_resumes(profile: ApplyProfile, jobs: list[any] | list[str]) -> list[str]:
    """Jobs/tracks in this queue whose resume file is absent from disk.

    Checked BEFORE the browser opens rather than at the upload. Discovering it
    mid-session means the founder has already reviewed a form he cannot submit,
    and the honest recovery — abandoning that application — costs him the one
    thing this tool exists to save.
    """
    problems: list[str] = []
    if jobs and hasattr(jobs[0], "track"):
        for job in jobs:
            job_id = getattr(job, "id", None)
            candidate = profile.resume_for(job.track, job_id)
            if not candidate:
                problems.append(f"{getattr(job, 'company', job.track)} ({job.track}): no resume configured")
            elif not Path(candidate).expanduser().is_file():
                problems.append(f"{getattr(job, 'company', job.track)} ({job.track}): file not found — {candidate}")
            elif profile.tailored_cv_missing(job):
                # candidate resolved to something real (the generic fallback),
                # but this row was promised a TAILORED one that never arrived —
                # the fallback would otherwise ship silently.
                problems.append(
                    f"{getattr(job, 'company', job.track)} ({job.track}): tailored CV never arrived "
                    "— will fall back to the generic resume unless fixed"
                )
    else:
        for track in sorted(set(jobs)):
            candidate = profile.resume_for(track)
            if not candidate:
                problems.append(f"{track}: no resume configured")
            elif not Path(candidate).expanduser().is_file():
                problems.append(f"{track}: file not found — {candidate}")
    return problems


def resume_unusable(profile: ApplyProfile, job) -> bool:
    """True only when there is NOTHING this row could upload at all.

    The one condition allowed to remove a job from today's browser queue
    (`apply.py`'s pre-flight filter). A row whose tailored CV is merely
    missing still has the generic PDF to fall back to — `missing_resumes`
    reports that as a problem so it is announced, but it is a problem worth
    showing, not a reason to silently drop the job for a day when it could
    still be sent today with the founder's knowledge.
    """
    candidate = profile.resume_for(job.track, getattr(job, "id", None))
    if not candidate:
        return True
    return not Path(candidate).expanduser().is_file()
