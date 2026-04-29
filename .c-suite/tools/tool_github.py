"""
FounderOS — GitHub Tool (Full Implementation)
===============================================
Manages Pushkar's GitHub profile + repositories via GitHub REST API.

Capabilities:
  - Read/write profile README (pushkarverma/pushkarverma repo)
  - List, create, update repositories
  - Star trending repos (for visibility)
  - Follow AI/ML developers
  - Get contribution stats
  - Create/update pinned repo descriptions

Required .env:
    GITHUB_TOKEN   — Personal Access Token (scopes: repo, user, read:org)
    GITHUB_USERNAME — e.g. "pushkarverma"

Get token: github.com → Settings → Developer settings → Personal access tokens
"""
from __future__ import annotations
import os, json, logging, base64
from datetime import datetime
from pathlib import Path

import httpx
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env", override=True)

log = logging.getLogger("github_tool")

GITHUB_API   = "https://api.github.com"
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
GITHUB_USER  = os.getenv("GITHUB_USERNAME", "pushkarverma")


def _headers() -> dict:
    return {
        "Authorization": f"token {GITHUB_TOKEN}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "FounderOS-Agent/1.0",
    }


def _check_token() -> str | None:
    if not GITHUB_TOKEN:
        return "ERROR: GITHUB_TOKEN not set in .env"
    return None


# ─────────────────────────────────────────────────────────────
# PROFILE README
# ─────────────────────────────────────────────────────────────

def github_get_readme() -> str:
    """Fetch current profile README content."""
    err = _check_token()
    if err:
        return err
    try:
        r = httpx.get(
            f"{GITHUB_API}/repos/{GITHUB_USER}/{GITHUB_USER}/contents/README.md",
            headers=_headers(), timeout=15
        )
        if r.status_code == 404:
            return "README.md does not exist yet. Use github_update_readme to create it."
        data = r.json()
        content = base64.b64decode(data["content"]).decode("utf-8")
        return f"SHA: {data['sha']}\n\n{content}"
    except Exception as e:
        return f"ERROR: {e}"


def github_update_readme(content: str) -> str:
    """
    Create or update the GitHub profile README.
    Input: new README content (markdown).
    """
    err = _check_token()
    if err:
        return err
    try:
        # Get current SHA (needed for update)
        r = httpx.get(
            f"{GITHUB_API}/repos/{GITHUB_USER}/{GITHUB_USER}/contents/README.md",
            headers=_headers(), timeout=15
        )
        sha = r.json().get("sha") if r.status_code == 200 else None

        payload = {
            "message": f"chore: update profile README [{datetime.utcnow().strftime('%Y-%m-%d')}]",
            "content": base64.b64encode(content.encode()).decode(),
            "committer": {"name": "FounderOS", "email": "bot@turicks.com"},
        }
        if sha:
            payload["sha"] = sha

        resp = httpx.put(
            f"{GITHUB_API}/repos/{GITHUB_USER}/{GITHUB_USER}/contents/README.md",
            headers=_headers(), json=payload, timeout=30
        )
        if resp.status_code in (200, 201):
            return f"✅ README updated: https://github.com/{GITHUB_USER}"
        return f"ERROR {resp.status_code}: {resp.text[:300]}"
    except Exception as e:
        return f"ERROR: {e}"


# ─────────────────────────────────────────────────────────────
# REPOSITORY MANAGEMENT
# ─────────────────────────────────────────────────────────────

def github_list_repos() -> str:
    """List all public repositories with stars and description."""
    err = _check_token()
    if err:
        return err
    try:
        r = httpx.get(
            f"{GITHUB_API}/users/{GITHUB_USER}/repos?sort=updated&per_page=30&type=owner",
            headers=_headers(), timeout=15
        )
        repos = r.json()
        lines = [f"📦 {GITHUB_USER} repos ({len(repos)} total):"]
        for repo in repos:
            stars = repo.get("stargazers_count", 0)
            desc = repo.get("description", "No description")[:60]
            lang = repo.get("language", "")
            lines.append(f"  ⭐{stars:3d} [{lang or '—':12s}] {repo['name']} — {desc}")
        return "\n".join(lines)
    except Exception as e:
        return f"ERROR: {e}"


def github_update_repo(payload: str) -> str:
    """
    Update repository description, topics, or homepage.
    Input: JSON string {"repo":"name","description":"...","topics":["ai","python"],"homepage":"url"}
    """
    err = _check_token()
    if err:
        return err
    try:
        data = json.loads(payload)
        repo = data.pop("repo")
        topics = data.pop("topics", None)

        # Update repo metadata
        if data:
            r = httpx.patch(
                f"{GITHUB_API}/repos/{GITHUB_USER}/{repo}",
                headers=_headers(), json=data, timeout=15
            )
            if r.status_code not in (200, 201):
                return f"ERROR updating repo: {r.text[:200]}"

        # Update topics separately
        if topics:
            t = httpx.put(
                f"{GITHUB_API}/repos/{GITHUB_USER}/{repo}/topics",
                headers={**_headers(), "Accept": "application/vnd.github.mercy-preview+json"},
                json={"names": topics}, timeout=15
            )
            if t.status_code not in (200, 201):
                return f"ERROR updating topics: {t.text[:200]}"

        return f"✅ {repo} updated"
    except Exception as e:
        return f"ERROR: {e}"


# ─────────────────────────────────────────────────────────────
# GROWTH: STAR & FOLLOW
# ─────────────────────────────────────────────────────────────

def github_star_repo(repo_full_name: str) -> str:
    """
    Star a repository to show interest + improve visibility.
    Input: 'owner/repo' e.g. 'langchain-ai/langgraph'
    """
    err = _check_token()
    if err:
        return err
    try:
        r = httpx.put(
            f"{GITHUB_API}/user/starred/{repo_full_name.strip()}",
            headers={**_headers(), "Content-Length": "0"}, timeout=15
        )
        if r.status_code == 204:
            return f"⭐ Starred: {repo_full_name}"
        return f"Already starred or error {r.status_code}"
    except Exception as e:
        return f"ERROR: {e}"


def github_follow_user(username: str) -> str:
    """
    Follow a GitHub user (increases your visibility in their followers' networks).
    Input: username string
    """
    err = _check_token()
    if err:
        return err
    try:
        r = httpx.put(
            f"{GITHUB_API}/user/following/{username.strip()}",
            headers={**_headers(), "Content-Length": "0"}, timeout=15
        )
        if r.status_code == 204:
            return f"✅ Following: {username}"
        return f"Already following or error {r.status_code}"
    except Exception as e:
        return f"ERROR: {e}"


def github_trending(payload: str = "python") -> str:
    """
    Search trending AI/ML repos to star and follow authors.
    Input: topic string e.g. 'langgraph' or 'ai-agents'
    """
    err = _check_token()
    if err:
        return err
    try:
        topic = payload.strip() or "ai-agents"
        r = httpx.get(
            f"{GITHUB_API}/search/repositories?q=topic:{topic}+stars:>50&sort=updated&per_page=10",
            headers=_headers(), timeout=15
        )
        repos = r.json().get("items", [])
        lines = [f"🔥 Trending: {topic} ({len(repos)} repos)"]
        for repo in repos[:10]:
            lines.append(
                f"  ⭐{repo['stargazers_count']:5d} {repo['full_name']} — {(repo.get('description') or '')[:60]}"
            )
        return "\n".join(lines)
    except Exception as e:
        return f"ERROR: {e}"


def github_get_stats() -> str:
    """Get profile stats: followers, following, public repos, contributions."""
    err = _check_token()
    if err:
        return err
    try:
        r = httpx.get(f"{GITHUB_API}/users/{GITHUB_USER}", headers=_headers(), timeout=15)
        u = r.json()
        return (
            f"👤 {u.get('name', GITHUB_USER)} (@{GITHUB_USER})\n"
            f"📝 Bio: {u.get('bio', 'Not set')}\n"
            f"👥 Followers: {u.get('followers', 0)} | Following: {u.get('following', 0)}\n"
            f"📦 Public Repos: {u.get('public_repos', 0)}\n"
            f"🌐 Blog: {u.get('blog', 'Not set')}\n"
            f"🏢 Company: {u.get('company', 'Not set')}\n"
            f"📍 Location: {u.get('location', 'Not set')}\n"
            f"🐦 Twitter: {u.get('twitter_username', 'Not set')}"
        )
    except Exception as e:
        return f"ERROR: {e}"


def github_update_profile(payload: str) -> str:
    """
    Update GitHub profile bio, blog, company, location, twitter.
    Input: JSON string {"bio":"...","blog":"...","company":"...","location":"...","twitter_username":"..."}
    """
    err = _check_token()
    if err:
        return err
    try:
        data = json.loads(payload)
        r = httpx.patch(
            f"{GITHUB_API}/user",
            headers=_headers(), json=data, timeout=15
        )
        if r.status_code == 200:
            return f"✅ Profile updated"
        return f"ERROR {r.status_code}: {r.text[:200]}"
    except Exception as e:
        return f"ERROR: {e}"


def github_create_repo(payload: str) -> str:
    """
    Create a new public repository.
    Input: JSON string {"name":"repo-name","description":"...","topics":["ai"]}
    """
    err = _check_token()
    if err:
        return err
    try:
        data = json.loads(payload)
        topics = data.pop("topics", [])
        data.setdefault("private", False)
        data.setdefault("auto_init", True)

        r = httpx.post(
            f"{GITHUB_API}/user/repos",
            headers=_headers(), json=data, timeout=15
        )
        if r.status_code == 201:
            repo_data = r.json()
            # Add topics
            if topics:
                httpx.put(
                    f"{GITHUB_API}/repos/{GITHUB_USER}/{data['name']}/topics",
                    headers={**_headers(), "Accept": "application/vnd.github.mercy-preview+json"},
                    json={"names": topics}, timeout=15
                )
            return f"✅ Repo created: {repo_data['html_url']}"
        return f"ERROR {r.status_code}: {r.text[:300]}"
    except Exception as e:
        return f"ERROR: {e}"
