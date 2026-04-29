"""
FounderOS — LinkedIn Tool
==========================
Primary:  LinkedIn REST API (ugcPosts — w_member_social scope)
Fallback: Playwright browser automation (if API quota / token expired)

Setup (one-time):
    python .c-suite/tools/linkedin_oauth_setup.py

Required .env keys:
    LINKEDIN_ACCESS_TOKEN   — OAuth2 bearer token
    LINKEDIN_PERSON_URN     — urn:li:person:XXXXXXX
    LINKEDIN_EMAIL          — fallback login (Playwright)
    LINKEDIN_PASSWORD       — fallback login (Playwright)
    LINKEDIN_COOKIES_PATH   — .c-suite/bridges/linkedin_cookies.json
"""
from __future__ import annotations
import os, json, logging
from datetime import datetime
from pathlib import Path

import httpx
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env", override=True)

log = logging.getLogger("linkedin_tool")

LINKEDIN_API_BASE = "https://api.linkedin.com/v2"
COOKIES_PATH = os.getenv(
    "LINKEDIN_COOKIES_PATH",
    ".c-suite/bridges/linkedin_cookies.json",
)


# ─────────────────────────────────────────────
# Core poster class
# ─────────────────────────────────────────────
class LinkedInPoster:
    """
    post_text()              → publish via REST API, Playwright fallback
    get_post_analytics()     → impressions / likes / comments for a post
    send_dm()                → send a LinkedIn InMail/message
    """

    def __init__(self):
        self.access_token = os.getenv("LINKEDIN_ACCESS_TOKEN", "")
        self.person_urn = os.getenv("LINKEDIN_PERSON_URN", "")
        self.headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json",
            "X-Restli-Protocol-Version": "2.0.0",
        }

    # ── Public posting ────────────────────────────────────────────────────────
    def post_text(self, content: str, visibility: str = "PUBLIC") -> dict:
        """
        Post a text-only LinkedIn post.
        Returns: {"success": bool, "post_id": str, "url": str, "error": str|None, "method": str}
        """
        if not self.access_token or not self.person_urn:
            return {
                "success": False, "post_id": None, "url": None,
                "error": "LINKEDIN_ACCESS_TOKEN or LINKEDIN_PERSON_URN not set. Run linkedin_oauth_setup.py",
                "method": "none",
            }

        payload = {
            "author": self.person_urn,
            "lifecycleState": "PUBLISHED",
            "specificContent": {
                "com.linkedin.ugc.ShareContent": {
                    "shareCommentary": {"text": content[:3000]},
                    "shareMediaCategory": "NONE",
                }
            },
            "visibility": {
                "com.linkedin.ugc.MemberNetworkVisibility": visibility
            },
        }

        try:
            resp = httpx.post(
                f"{LINKEDIN_API_BASE}/ugcPosts",
                headers=self.headers,
                json=payload,
                timeout=30,
            )
            if resp.status_code == 201:
                post_id = resp.headers.get("X-RestLi-Id", "")
                url = f"https://www.linkedin.com/feed/update/{post_id}/"
                log.info(f"[LinkedIn] Posted via API: {post_id}")
                return {
                    "success": True, "post_id": post_id, "url": url,
                    "error": None, "method": "api",
                    "posted_at": datetime.utcnow().isoformat(),
                }
            else:
                log.warning(f"[LinkedIn] API returned {resp.status_code} — trying Playwright")
                return self._post_via_playwright(content)

        except Exception as e:
            log.warning(f"[LinkedIn] API exception: {e} — trying Playwright")
            return self._post_via_playwright(content)

    # ── Playwright fallback ───────────────────────────────────────────────────
    def _post_via_playwright(self, content: str) -> dict:
        """Browser automation fallback. Requires: playwright install chromium"""
        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                context = browser.new_context()

                # Restore saved session
                cookies_file = Path(COOKIES_PATH)
                if cookies_file.exists():
                    with open(cookies_file) as f:
                        context.add_cookies(json.load(f))

                page = context.new_page()
                page.goto("https://www.linkedin.com/feed/", timeout=20000)

                # Login if needed
                if "login" in page.url or "authwall" in page.url:
                    email = os.getenv("LINKEDIN_EMAIL", "")
                    pwd = os.getenv("LINKEDIN_PASSWORD", "")
                    if not email or not pwd:
                        return {
                            "success": False, "post_id": None, "url": None,
                            "error": "LinkedIn session expired and LINKEDIN_EMAIL/PASSWORD not set.",
                            "method": "playwright",
                        }
                    page.fill("#username", email)
                    page.fill("#password", pwd)
                    page.click('[data-id="sign-in-form__submit-btn"]')
                    page.wait_for_url("**/feed/**", timeout=20000)
                    # Persist cookies
                    cookies_file.parent.mkdir(parents=True, exist_ok=True)
                    with open(cookies_file, "w") as f:
                        json.dump(context.cookies(), f)

                # Open post composer
                page.click('[aria-label="Start a post"]')
                page.wait_for_selector(".ql-editor", timeout=8000)
                page.fill(".ql-editor", content[:3000])
                page.wait_for_timeout(1500)
                page.click('[aria-label="Post"]')
                page.wait_for_timeout(4000)
                browser.close()

                post_id = f"playwright_{int(datetime.utcnow().timestamp())}"
                log.info(f"[LinkedIn] Posted via Playwright: {post_id}")
                return {
                    "success": True,
                    "post_id": post_id,
                    "url": "https://www.linkedin.com/feed/",
                    "error": None,
                    "method": "playwright",
                    "posted_at": datetime.utcnow().isoformat(),
                }

        except Exception as e:
            return {
                "success": False, "post_id": None, "url": None,
                "error": str(e), "method": "playwright",
                "posted_at": datetime.utcnow().isoformat(),
            }

    # ── Analytics ─────────────────────────────────────────────────────────────
    def get_post_analytics(self, post_id: str) -> dict:
        """
        Get engagement data for a post (call 24h+ after posting).
        post_id: the X-RestLi-Id value from post_text() result.
        """
        if post_id.startswith("playwright_"):
            return {"error": "Analytics not available for Playwright-posted content"}
        try:
            # Share statistics endpoint
            encoded = post_id.replace(":", "%3A")
            resp = httpx.get(
                f"{LINKEDIN_API_BASE}/organizationalEntityShareStatistics"
                f"?q=organizationalEntity&organizationalEntity={encoded}",
                headers=self.headers,
                timeout=15,
            )
            if resp.status_code == 200:
                d = resp.json()
                stats = d.get("elements", [{}])[0].get("totalShareStatistics", {})
                return {
                    "post_id": post_id,
                    "impressions": stats.get("impressionCount", 0),
                    "likes":       stats.get("likeCount", 0),
                    "comments":    stats.get("commentCount", 0),
                    "shares":      stats.get("shareCount", 0),
                    "clicks":      stats.get("clickCount", 0),
                }
            return {"error": f"API {resp.status_code}: {resp.text[:200]}"}
        except Exception as e:
            return {"error": str(e)}

    # ── LinkedIn DM ───────────────────────────────────────────────────────────
    def send_dm(self, recipient_urn: str, message: str) -> dict:
        """
        Send a LinkedIn direct message.
        recipient_urn: urn:li:person:XXXXX (found via profile URL)
        """
        if not self.access_token:
            return {"success": False, "error": "No access token"}
        try:
            payload = {
                "recipients": {
                    "values": [{"person": {"com.linkedin.common.urn": recipient_urn}}]
                },
                "subject": "FounderOS Outreach",
                "body": message[:2000],
            }
            resp = httpx.post(
                f"{LINKEDIN_API_BASE}/messages",
                headers=self.headers,
                json=payload,
                timeout=20,
            )
            return {
                "success": resp.status_code in (200, 201),
                "status_code": resp.status_code,
                "sent_at": datetime.utcnow().isoformat(),
                "error": None if resp.status_code in (200, 201) else resp.text[:200],
            }
        except Exception as e:
            return {"success": False, "error": str(e)}


# ─────────────────────────────────────────────
# Module-level tool functions (called by departments/tools.py)
# ─────────────────────────────────────────────
def linkedin_post(content: str, visibility: str = "PUBLIC") -> str:
    """Tool: post to LinkedIn. Returns JSON string result."""
    result = LinkedInPoster().post_text(content, visibility)
    return json.dumps(result, indent=2)


def linkedin_get_analytics(post_id: str) -> str:
    """Tool: get post analytics. Returns JSON string."""
    result = LinkedInPoster().get_post_analytics(post_id)
    return json.dumps(result, indent=2)


def linkedin_dm(recipient_urn: str, message: str) -> str:
    """Tool: send LinkedIn DM. Returns JSON string."""
    result = LinkedInPoster().send_dm(recipient_urn, message)
    return json.dumps(result, indent=2)
