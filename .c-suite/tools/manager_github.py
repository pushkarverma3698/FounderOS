"""
FounderOS V8 — GitHub Manager Tool
====================================
Native Python wrapper for GitHub PR management and Repo analysis.
Mimics Claude Code's high-reliability recursive tools.
"""

import json
import logging
import os
import httpx

log = logging.getLogger("GitHubManager")

class GitHubManager:
    def __init__(self, token: str = ""):
        self.token = token or os.getenv("GITHUB_TOKEN", "")
        self.headers = {
            "Authorization": f"token {self.token}",
            "Accept": "application/vnd.github.v3+json"
        }

    async def list_pull_requests(self, repo: str) -> list[dict]:
        """Fetch active PRs for a given repository."""
        url = f"https://api.github.com/repos/{repo}/pulls"
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, headers=self.headers)
            resp.raise_for_status()
            return resp.json()

    async def comment_on_pr(self, repo: str, pr_number: int, comment: str) -> dict:
        """Post a review comment on a PR (used by senior_dev / qa_tester)."""
        url = f"https://api.github.com/repos/{repo}/issues/{pr_number}/comments"
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, headers=self.headers, json={"body": comment})
            resp.raise_for_status()
            return resp.json()

    async def create_issue(self, repo: str, title: str, body: str) -> dict:
        """Create a bug report or task issue."""
        url = f"https://api.github.com/repos/{repo}/issues"
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, headers=self.headers, json={"title": title, "body": body})
            resp.raise_for_status()
            return resp.json()

if __name__ == "__main__":
    # Test initialization
    manager = GitHubManager()
    print("GitHubManager check: Ready for V8 Sovereign PR review loops.")
