"""
FounderOS — Upwork Tool (bidding_sniper)
=========================================
Searches for jobs and submits proposals via Upwork API v3.

Required .env keys:
    UPWORK_API_KEY
    UPWORK_API_SECRET
    UPWORK_ACCESS_TOKEN
    UPWORK_ACCESS_SECRET

Fallback (no API keys): searches via RSS/GraphQL public endpoint.

Setup: https://www.upwork.com/developer/keys/new
Scope: "read" + "write" + "jobs"
"""
from __future__ import annotations
import os, json, logging
from datetime import datetime, timedelta, timezone

import httpx

log = logging.getLogger("upwork_tool")

UPWORK_API_KEY      = os.getenv("UPWORK_API_KEY", "")
UPWORK_ACCESS_TOKEN = os.getenv("UPWORK_ACCESS_TOKEN", "")

# ── Turicks ideal client profile ─────────────────────────────────────────────
SEARCH_QUERIES = [
    "LangGraph developer",
    "LangChain AI agent",
    "autonomous AI agent python",
    "RAG chatbot developer",
    "LLM integration developer",
    "AI agent SaaS development",
    "OpenAI API integration",
    "multi-agent system developer",
]

PRICING = {
    "simple_integration": (800, 1500),
    "langgraph_agent":    (2000, 5000),
    "full_pipeline":      (5000, 12000),
    "hourly_standard":    45,
    "hourly_complex":     70,
}


# ─────────────────────────────────────────────
# Job search
# ─────────────────────────────────────────────
def search_upwork_jobs(query: str, limit: int = 10) -> list[dict]:
    """
    Search Upwork for open jobs matching query.
    Returns list of job dicts: {id, title, budget, description, client_rating, posted_at, url}
    Falls back to Upwork RSS if API keys not configured.
    """
    if UPWORK_API_KEY and UPWORK_ACCESS_TOKEN:
        return _search_via_api(query, limit)
    return _search_via_rss(query, limit)


def _search_via_api(query: str, limit: int) -> list[dict]:
    try:
        resp = httpx.get(
            "https://www.upwork.com/api/profiles/v2/search/jobs.json",
            params={"q": query, "sort": "recency", "paging": f"0;{limit}", "job_status": "open"},
            headers={"Authorization": f"Bearer {UPWORK_ACCESS_TOKEN}"},
            timeout=20,
        )
        if resp.status_code != 200:
            log.warning(f"Upwork API {resp.status_code}")
            return []
        jobs_raw = resp.json().get("jobs", {}).get("job", [])
        return [_normalize_job(j) for j in jobs_raw]
    except Exception as e:
        log.error(f"Upwork API error: {e}")
        return []


def _search_via_rss(query: str, limit: int) -> list[dict]:
    """Upwork RSS feed — no auth needed, last 24h jobs."""
    import xml.etree.ElementTree as ET
    try:
        import urllib.parse
        encoded = urllib.parse.quote_plus(query)
        resp = httpx.get(
            f"https://www.upwork.com/ab/feed/jobs/rss?q={encoded}&sort=recency&paging=0%3B{limit}",
            headers={"User-Agent": "Mozilla/5.0"},
            timeout=20,
            follow_redirects=True,
        )
        root = ET.fromstring(resp.text)
        jobs = []
        for item in root.findall(".//item")[:limit]:
            title = item.findtext("title", "")
            link  = item.findtext("link", "")
            desc  = item.findtext("description", "")[:400]
            pub   = item.findtext("pubDate", "")
            jobs.append({
                "id": link.split("/")[-1] if link else "",
                "title": title,
                "budget": "Unknown",
                "description": desc,
                "client_rating": "N/A",
                "posted_at": pub,
                "url": link,
                "source": "rss",
            })
        return jobs
    except Exception as e:
        log.error(f"Upwork RSS error: {e}")
        return []


def _normalize_job(raw: dict) -> dict:
    return {
        "id":            raw.get("id", {}).get("value", raw.get("id", "")),
        "title":         raw.get("title", ""),
        "budget":        raw.get("budget", {}).get("amount", "Unknown"),
        "description":   raw.get("snippet", "")[:500],
        "client_rating": raw.get("client", {}).get("feedback", "N/A"),
        "posted_at":     raw.get("date_created", ""),
        "url":           f"https://www.upwork.com/jobs/{raw.get('id',{}).get('value','')}",
        "source":        "api",
    }


# ─────────────────────────────────────────────
# Proposal submission
# ─────────────────────────────────────────────
def submit_proposal(job_id: str, cover_letter: str, bid_amount: float) -> dict:
    """
    Submit a proposal to an Upwork job.
    Returns {"success": bool, "proposal_id": str, "submitted_at": str, "error": str|None}
    """
    if not UPWORK_API_KEY or not UPWORK_ACCESS_TOKEN:
        # Dry-run mode — log the proposal for manual submission
        return {
            "success": False,
            "proposal_id": None,
            "submitted_at": datetime.utcnow().isoformat(),
            "error": "UPWORK_API_KEY not set — proposal saved for manual submission",
            "dry_run": True,
            "cover_letter_preview": cover_letter[:300],
        }
    try:
        resp = httpx.post(
            "https://www.upwork.com/api/hr/v3/contracts/offers",
            headers={"Authorization": f"Bearer {UPWORK_ACCESS_TOKEN}"},
            json={
                "job_reference": job_id,
                "cover_letter":  cover_letter[:3000],
                "charge_rate":   bid_amount,
            },
            timeout=20,
        )
        pid = resp.json().get("offer", {}).get("reference", "")
        return {
            "success": resp.status_code in (200, 201),
            "proposal_id": pid,
            "submitted_at": datetime.utcnow().isoformat(),
            "error": None if resp.status_code in (200, 201) else resp.text[:200],
        }
    except Exception as e:
        return {
            "success": False, "proposal_id": None,
            "submitted_at": datetime.utcnow().isoformat(),
            "error": str(e),
        }


# ─────────────────────────────────────────────
# Module-level tool functions
# ─────────────────────────────────────────────
def upwork_search(query: str, limit: int = 8) -> str:
    """Tool: search Upwork for jobs. Returns JSON list."""
    jobs = search_upwork_jobs(query, limit)
    return json.dumps(jobs, indent=2)


def upwork_submit(payload_json: str) -> str:
    """
    Tool: submit an Upwork proposal.
    Input JSON: {"job_id": "...", "cover_letter": "...", "bid_amount": 2500}
    """
    try:
        d = json.loads(payload_json)
    except Exception:
        return json.dumps({"success": False, "error": "Input must be JSON with job_id, cover_letter, bid_amount"})
    result = submit_proposal(
        d.get("job_id", ""),
        d.get("cover_letter", ""),
        float(d.get("bid_amount", 1000)),
    )
    return json.dumps(result, indent=2)


def upwork_search_all(limit_per_query: int = 5) -> str:
    """Tool: search all ICP queries and return merged results."""
    all_jobs = []
    for q in SEARCH_QUERIES:
        all_jobs.extend(search_upwork_jobs(q, limit_per_query))
    # Deduplicate by URL
    seen, unique = set(), []
    for j in all_jobs:
        key = j.get("url", j.get("title", ""))
        if key not in seen:
            seen.add(key)
            unique.append(j)
    return json.dumps(unique[:30], indent=2)
