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
    else:
        for track in sorted(set(jobs)):
            candidate = profile.resume_for(track)
            if not candidate:
                problems.append(f"{track}: no resume configured")
            elif not Path(candidate).expanduser().is_file():
                problems.append(f"{track}: file not found — {candidate}")
    return problems
