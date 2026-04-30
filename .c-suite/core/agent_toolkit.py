"""
FounderOS — Agent Toolkit
==========================
Pre-built, tested functions agents can import directly in generated scripts.
Every function here is tested to work in the mlx_env environment.

Usage in generated scripts:
    from core.agent_toolkit import web_search, fetch_page, linkedin_get_my_posts
    from core.agent_toolkit import store_memory, recall_memory, linkedin_post

All functions print progress to stdout and never silently swallow errors.
"""
from __future__ import annotations
import os, time, json, re, logging
from typing import List, Dict, Any, Optional
from dotenv import load_dotenv

load_dotenv("/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite/.env", override=True)

log = logging.getLogger("AgentToolkit")

CHROMA_PATH = "/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite/memory/chroma_data"
LINKEDIN_TOKEN = os.getenv("LINKEDIN_ACCESS_TOKEN", "")
LINKEDIN_URN   = os.getenv("LINKEDIN_PERSON_URN", "")


# ─── WEB SEARCH ──────────────────────────────────────────────────────────────

def web_search(query: str, n: int = 5) -> List[Dict]:
    """
    Search the web using DuckDuckGo HTML (no API key needed).
    Returns list of {title, url, snippet}.
    """
    import httpx
    from bs4 import BeautifulSoup

    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
    }
    try:
        resp = httpx.get(
            "https://html.duckduckgo.com/html/",
            params={"q": query, "kl": "us-en"},
            headers=headers, timeout=15, follow_redirects=True,
        )
        soup = BeautifulSoup(resp.text, "html.parser")
        results = []
        for r in soup.select(".result__body")[:n]:
            title_el = r.select_one(".result__title a")
            snip_el  = r.select_one(".result__snippet")
            url_el   = r.select_one(".result__url")
            results.append({
                "title":   title_el.get_text(strip=True) if title_el else "",
                "url":     url_el.get_text(strip=True) if url_el else "",
                "snippet": snip_el.get_text(strip=True) if snip_el else "",
            })
        print(f"[web_search] '{query}' → {len(results)} results")
        return results
    except Exception as e:
        print(f"[web_search] ERROR: {e}")
        return []


def fetch_page(url: str, max_chars: int = 8000) -> str:
    """Fetch a URL and return clean text content."""
    import httpx
    from bs4 import BeautifulSoup
    try:
        headers = {"User-Agent": "Mozilla/5.0 (compatible; FounderOS/1.0)"}
        resp = httpx.get(url, headers=headers, timeout=20, follow_redirects=True)
        soup = BeautifulSoup(resp.text, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header"]):
            tag.decompose()
        text = soup.get_text(separator="\n", strip=True)
        text = re.sub(r"\n{3,}", "\n\n", text)
        print(f"[fetch_page] {url} → {len(text)} chars")
        return text[:max_chars]
    except Exception as e:
        print(f"[fetch_page] ERROR: {e}")
        return f"ERROR: {e}"


# ─── LINKEDIN API ─────────────────────────────────────────────────────────────

def _li_headers() -> dict:
    return {
        "Authorization": f"Bearer {LINKEDIN_TOKEN}",
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
    }


def linkedin_get_my_posts(count: int = 10) -> List[Dict]:
    """
    NOTE: LinkedIn API read scope (r_member_social) is not available with this token.
    Returns posts from social_mem ChromaDB instead (where we store published posts).
    """
    posts = recall_memory("social_mem", "linkedin post published", n=count)
    results = []
    for p in posts:
        results.append({"text": p[:300], "source": "social_mem", "likes": "unknown", "comments": "unknown"})
    print(f"[linkedin_get_my_posts] {len(results)} posts from social_mem (API read scope not available)")
    return results


def linkedin_get_profile() -> Dict:
    """
    NOTE: LinkedIn API r_liteprofile scope not available with current token.
    Returns profile from canonical social_mem facts instead.
    """
    docs = recall_memory("social_mem", "Pushkar Verma identity LinkedIn", n=2)
    profile = {
        "name": "Pushkar Verma",
        "linkedin": "linkedin.com/in/pushkar-verma-809155234",
        "headline": "Full-Stack Engineer | AI Systems | LangGraph | Founder of Turicks & Naggar Retreat",
        "location": "Amsterdam, Netherlands",
        "note": "API read scope unavailable — data from social_mem",
        "raw_docs": [d[:200] for d in docs],
    }
    print(f"[linkedin_get_profile] Returned from memory (API scope limited)")
    return profile


def linkedin_post(text: str) -> Dict:
    """Post a text update to LinkedIn as Pushkar Verma."""
    import httpx
    if not LINKEDIN_TOKEN or not LINKEDIN_URN:
        print("[linkedin_post] ERROR: Missing credentials")
        return {"success": False, "error": "Missing credentials"}
    payload = {
        "author": LINKEDIN_URN,
        "lifecycleState": "PUBLISHED",
        "specificContent": {
            "com.linkedin.ugc.ShareContent": {
                "shareCommentary": {"text": text},
                "shareMediaCategory": "NONE",
            }
        },
        "visibility": {"com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"},
    }
    try:
        r = httpx.post("https://api.linkedin.com/v2/ugcPosts",
                       headers=_li_headers(), json=payload, timeout=30)
        if r.status_code in (200, 201):
            post_id = r.headers.get("x-restli-id", "unknown")
            url = f"https://www.linkedin.com/feed/update/{post_id}/"
            print(f"[linkedin_post] LIVE: {url}")
            return {"success": True, "post_id": post_id, "url": url}
        else:
            print(f"[linkedin_post] FAILED: {r.status_code} {r.text[:300]}")
            return {"success": False, "status": r.status_code, "error": r.text[:300]}
    except Exception as e:
        print(f"[linkedin_post] ERROR: {e}")
        return {"success": False, "error": str(e)}


# ─── CHROMADB MEMORY ─────────────────────────────────────────────────────────

def store_memory(collection: str, doc_id: str, text: str, meta: dict = None) -> bool:
    """Write a document to ChromaDB. collection = 'turicks_mem' | 'naggar_mem' | 'social_mem' | 'career_mem'."""
    import chromadb
    try:
        client = chromadb.PersistentClient(path=CHROMA_PATH)
        col = client.get_or_create_collection(collection)
        col.upsert(
            documents=[text], ids=[doc_id],
            metadatas=[{**(meta or {}), "updated": time.strftime("%Y-%m-%d")}],
        )
        print(f"[store_memory] ✅ {collection}/{doc_id}")
        return True
    except Exception as e:
        print(f"[store_memory] ERROR: {e}")
        return False


def recall_memory(collection: str, query: str, n: int = 5) -> List[str]:
    """Semantic search in ChromaDB. Returns list of matching text chunks."""
    import chromadb
    try:
        client = chromadb.PersistentClient(path=CHROMA_PATH)
        col = client.get_or_create_collection(collection)
        if col.count() == 0:
            return []
        res = col.query(query_texts=[query], n_results=min(n, col.count()))
        docs = res.get("documents", [[]])[0]
        print(f"[recall_memory] {collection} '{query}' → {len(docs)} docs")
        return docs
    except Exception as e:
        print(f"[recall_memory] ERROR: {e}")
        return []


def list_all_collections() -> List[Dict]:
    """List all ChromaDB collections with their document counts."""
    import chromadb
    client = chromadb.PersistentClient(path=CHROMA_PATH)
    cols = client.list_collections()
    result = [{"name": c.name, "count": c.count()} for c in cols]
    for r in result:
        print(f"  {r['name']}: {r['count']} docs")
    return result
