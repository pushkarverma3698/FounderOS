"""
FounderOS — Content Calendar
==============================
Tracks LinkedIn post schedule and logs history.
Used by social_handler to decide what to post and avoid repetition.
"""
from __future__ import annotations
import json
from datetime import datetime, timedelta
from pathlib import Path

CALENDAR_PATH = Path(__file__).parent.parent / "memory" / "content_calendar.json"

# Weekly posting slots (IST = UTC+5:30)
WEEKLY_SLOTS = [
    {"day": "Tuesday",  "time": "09:00", "tz": "Asia/Kolkata", "pillar": "BUILD_LOG"},
    {"day": "Thursday", "time": "11:00", "tz": "Asia/Kolkata", "pillar": "AI_EDUCATION"},
    {"day": "Saturday", "time": "10:00", "tz": "Asia/Kolkata", "pillar": "FOUNDER_STORY"},
]

DAY_ORDER = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


def get_next_post_slot() -> dict:
    """Return the next scheduled posting slot with its pillar type."""
    now = datetime.now()
    today_idx = now.weekday()  # 0 = Monday

    candidates = []
    for slot in WEEKLY_SLOTS:
        slot_idx = DAY_ORDER.index(slot["day"])
        h, m = map(int, slot["time"].split(":"))
        days_ahead = (slot_idx - today_idx) % 7
        candidate_dt = now.replace(hour=h, minute=m, second=0, microsecond=0) + timedelta(days=days_ahead)
        if candidate_dt <= now:
            candidate_dt += timedelta(days=7)
        candidates.append({**slot, "datetime": candidate_dt.isoformat(), "dt_obj": candidate_dt})

    candidates.sort(key=lambda x: x["dt_obj"])
    best = candidates[0]
    return {"datetime": best["datetime"], "pillar": best["pillar"], "day": best["day"], "time": best["time"]}


def get_todays_pillar() -> str | None:
    """Return the pillar for today if it's a posting day, else None."""
    today_name = DAY_ORDER[datetime.now().weekday()]
    for slot in WEEKLY_SLOTS:
        if slot["day"] == today_name:
            return slot["pillar"]
    return None


def load_calendar() -> dict:
    if CALENDAR_PATH.exists():
        return json.loads(CALENDAR_PATH.read_text())
    return {}


def log_posted(
    post_id: str,
    url: str,
    pillar: str,
    content_preview: str,
    method: str = "api",
) -> None:
    calendar = load_calendar()
    key = datetime.utcnow().strftime("%Y-%m-%d")
    calendar[key] = {
        "post_id":        post_id,
        "url":            url,
        "pillar":         pillar,
        "preview":        content_preview[:120],
        "method":         method,
        "posted_at":      datetime.utcnow().isoformat(),
    }
    CALENDAR_PATH.parent.mkdir(parents=True, exist_ok=True)
    CALENDAR_PATH.write_text(json.dumps(calendar, indent=2))


def get_recent_pillars(n: int = 5) -> list[str]:
    """Return pillar names of the last n posts, newest first."""
    calendar = load_calendar()
    sorted_entries = sorted(calendar.items(), key=lambda x: x[0], reverse=True)
    return [entry["pillar"] for _, entry in sorted_entries[:n]]


def get_calendar_summary() -> str:
    """Human-readable summary for agents."""
    calendar = load_calendar()
    if not calendar:
        return "No posts logged yet."
    lines = [f"📅 Content Calendar ({len(calendar)} posts logged):"]
    for date, entry in sorted(calendar.items(), reverse=True)[:10]:
        lines.append(f"  {date} [{entry['pillar']}] — {entry.get('preview','')[:60]}")
    next_slot = get_next_post_slot()
    lines.append(f"\n⏭  Next post: {next_slot['day']} {next_slot['time']} IST → {next_slot['pillar']}")
    return "\n".join(lines)
