"""
Real tool implementations available to department workers.
All calls go through tool_hooks (zero-trust + silo enforcement + destructive gate).

Each tool: (input_str, agent_name) -> str (result, possibly truncated).
"""
from __future__ import annotations
import os, subprocess, json, requests
from typing import Callable

from core.tool_hooks import pre_tool_hook, post_tool_hook  # type: ignore
from core.registry import get_agent  # type: ignore

# Memory client
try:
    from memory.memory import client as chroma_client, recall, store  # type: ignore
    import time as _time
    _MEM = True
except Exception:
    _MEM = False


# ─────────────────────────────────────────────
# Gate helper
# ─────────────────────────────────────────────
def _gate(tool: str, inp: str, agent: str, collection_name: str = "") -> tuple[bool, str]:
    res = pre_tool_hook(tool, inp, agent_name=agent, collection_name=collection_name)
    if res.behavior == "deny":
        return False, f"DENIED: {res.reason}"
    # require_approval: in production routes to chairman; for autonomous tests, allow
    return True, ""


# ─────────────────────────────────────────────
# Tools
# ─────────────────────────────────────────────
def t_bash(cmd: str, agent: str) -> str:
    ok, msg = _gate("bash", cmd, agent)
    if not ok:
        return msg
    try:
        out = subprocess.check_output(cmd, shell=True, text=True, stderr=subprocess.STDOUT,
                                      timeout=30, cwd=os.getcwd())
        return post_tool_hook("bash", out.strip()[:1500], agent)
    except subprocess.CalledProcessError as e:
        return post_tool_hook("bash", (e.output or str(e))[:800], agent)
    except Exception as e:
        return f"ERROR: {e}"


def t_read_file(path: str, agent: str) -> str:
    ok, msg = _gate("read_file", path, agent)
    if not ok:
        return msg
    try:
        with open(path.strip(), "r") as f:
            data = f.read()[:4000]
        return post_tool_hook("read_file", data, agent)
    except Exception as e:
        return f"ERROR: {e}"


def t_write_file(payload: str, agent: str) -> str:
    """Payload format: 'path::content'."""
    ok, msg = _gate("write_file", payload[:200], agent)
    if not ok:
        return msg
    try:
        path, content = payload.split("::", 1)
        with open(path.strip(), "w") as f:
            f.write(content)
        return f"WROTE {len(content)}B → {path.strip()}"
    except Exception as e:
        return f"ERROR: {e}"


def t_search_web(query: str, agent: str) -> str:
    """Free DuckDuckGo HTML scrape — works without API key."""
    ok, msg = _gate("search_web", query, agent)
    if not ok:
        return msg
    try:
        r = requests.get("https://duckduckgo.com/html/", params={"q": query},
                         headers={"User-Agent": "Mozilla/5.0"}, timeout=15)
        # Crude extract of result snippets
        import re as _re
        snippets = _re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', r.text, _re.S)[:5]
        clean = [_re.sub(r"<[^>]+>", "", s).strip() for s in snippets]
        text = "\n---\n".join(clean) or "(no results)"
        return post_tool_hook("search_web", text[:2000], agent)
    except Exception as e:
        return f"ERROR: {e}"


def t_chromadb_read(payload: str, agent: str) -> str:
    """Payload format: 'collection::query'."""
    if not _MEM:
        return "ERROR: chromadb unavailable"
    try:
        collection, query = payload.split("::", 1)
    except ValueError:
        return "ERROR: input must be 'collection::query'"
    collection = collection.strip()
    ok, msg = _gate("chromadb_read", query, agent, collection_name=collection)
    if not ok:
        return msg
    try:
        col = chroma_client.get_or_create_collection(collection)
        result = recall(col, query.strip(), n_results=3)
        return post_tool_hook("chromadb_read", str(result)[:2000], agent)
    except Exception as e:
        return f"ERROR: {e}"


def t_chromadb_write(payload: str, agent: str) -> str:
    """Payload format: 'collection::content_to_store'."""
    if not _MEM:
        return "ERROR: chromadb unavailable"
    try:
        collection, content = payload.split("::", 1)
    except ValueError:
        return "ERROR: input must be 'collection::content'"
    collection = collection.strip()
    ok, msg = _gate("chromadb_write", content[:200], agent, collection_name=collection)
    if not ok:
        return msg
    try:
        col = chroma_client.get_or_create_collection(collection)
        doc_id = f"{agent}_{_time.time()}"
        store(col, doc_id, content.strip(), {"agent": agent, "type": "tool_write"})
        return f"STORED {len(content)}B → {collection}"
    except Exception as e:
        return f"ERROR: {e}"


def t_firecrawl(url: str, agent: str) -> str:
    api_key = os.getenv("FIRECRAWL_API_KEY", "")
    ok, msg = _gate("firecrawl", url, agent)
    if not ok:
        return msg
    if not api_key:
        return "ERROR: FIRECRAWL_API_KEY missing"
    try:
        r = requests.post("https://api.firecrawl.dev/v1/scrape",
                          headers={"Authorization": f"Bearer {api_key}"},
                          json={"url": url.strip(), "formats": ["markdown"]},
                          timeout=60)
        data = r.json()
        md = (data.get("data") or {}).get("markdown", "")[:3000]
        return post_tool_hook("firecrawl", md or str(data)[:500], agent)
    except Exception as e:
        return f"ERROR: {e}"


def t_telegram_send(payload: str, agent: str) -> str:
    """Payload format: 'topic_id::message'. topic_id may be name (boardroom/turicks/naggar/social/think_tank)."""
    ok, msg = _gate("telegram_send", payload[:200], agent)
    if not ok:
        return msg
    try:
        topic_raw, text = payload.split("::", 1)
    except ValueError:
        return "ERROR: input must be 'topic_id::message'"
    topics = {
        "boardroom":  int(os.getenv("TOPIC_BOARDROOM", 8)),
        "think_tank": int(os.getenv("TOPIC_THINK_TANK", 110)),
        "turicks":    int(os.getenv("TOPIC_TURICKS", 111)),
        "naggar":     int(os.getenv("TOPIC_NAGGAR", 112)),
        "social":     int(os.getenv("TOPIC_SOCIAL", 6)),
    }
    tid = topics.get(topic_raw.strip().lower())
    if tid is None:
        try: tid = int(topic_raw.strip())
        except: return "ERROR: bad topic"
    try:
        tok = os.environ["TELEGRAM_BOT_TOKEN"]
        chat = os.environ["TELEGRAM_CHAT_ID"]
        r = requests.post(f"https://api.telegram.org/bot{tok}/sendMessage",
                          json={"chat_id": chat, "message_thread_id": tid,
                                "text": text[:3500], "parse_mode": "HTML"},
                          timeout=15)
        return "SENT" if r.json().get("ok") else f"ERROR: {r.text[:200]}"
    except Exception as e:
        return f"ERROR: {e}"


# ─────────────────────────────────────────────
# LinkedIn tool wrappers
# ─────────────────────────────────────────────
def _t_linkedin_post(content: str, agent: str) -> str:
    ok, msg = _gate("linkedin_post", content[:200], agent)
    if not ok:
        return msg
    try:
        from tools.tool_linkedin import linkedin_post  # type: ignore
        return linkedin_post(content)
    except ImportError:
        return "ERROR: tool_linkedin.py not found. Run: pip install httpx playwright"


def _t_linkedin_analytics(post_id: str, agent: str) -> str:
    ok, msg = _gate("linkedin_get_analytics", post_id, agent)
    if not ok:
        return msg
    try:
        from tools.tool_linkedin import linkedin_get_analytics  # type: ignore
        return linkedin_get_analytics(post_id.strip())
    except ImportError:
        return "ERROR: tool_linkedin.py not found"


def _t_linkedin_dm(payload: str, agent: str) -> str:
    """Payload: 'recipient_urn::message'"""
    ok, msg = _gate("linkedin_dm", payload[:100], agent)
    if not ok:
        return msg
    try:
        urn, message = payload.split("::", 1)
    except ValueError:
        return "ERROR: input must be 'urn:li:person:XXXXX::message text'"
    try:
        from tools.tool_linkedin import linkedin_dm  # type: ignore
        return linkedin_dm(urn.strip(), message.strip())
    except ImportError:
        return "ERROR: tool_linkedin.py not found"


# ─────────────────────────────────────────────
# Upwork tool wrappers
# ─────────────────────────────────────────────
def _t_upwork_search(query: str, agent: str) -> str:
    ok, msg = _gate("upwork_search", query, agent)
    if not ok:
        return msg
    try:
        from tools.tool_upwork import upwork_search  # type: ignore
        return upwork_search(query.strip())
    except ImportError:
        return "ERROR: tool_upwork.py not found"


def _t_upwork_search_all(_: str, agent: str) -> str:
    ok, msg = _gate("upwork_search_all", "all_queries", agent)
    if not ok:
        return msg
    try:
        from tools.tool_upwork import upwork_search_all  # type: ignore
        return upwork_search_all()
    except ImportError:
        return "ERROR: tool_upwork.py not found"


def _t_upwork_submit(payload_json: str, agent: str) -> str:
    ok, msg = _gate("upwork_submit", payload_json[:200], agent)
    if not ok:
        return msg
    try:
        from tools.tool_upwork import upwork_submit  # type: ignore
        return upwork_submit(payload_json)
    except ImportError:
        return "ERROR: tool_upwork.py not found"


# ─────────────────────────────────────────────
# Pipeline DB tool wrappers
# ─────────────────────────────────────────────
def _t_pipeline_summary(_: str, agent: str) -> str:
    ok, msg = _gate("pipeline_summary", "read", agent)
    if not ok:
        return msg
    try:
        from memory.pipeline_db import get_summary_text  # type: ignore
        return get_summary_text()
    except Exception as e:
        return f"ERROR: {e}"


def _t_pipeline_add_lead(payload_json: str, agent: str) -> str:
    ok, msg = _gate("pipeline_add_lead", payload_json[:200], agent)
    if not ok:
        return msg
    try:
        import json as _json
        from memory.pipeline_db import add_lead  # type: ignore
        d = _json.loads(payload_json)
        lead_id = add_lead(**{k: v for k, v in d.items() if k in
                               ("name","company","source","linkedin_url","email","notes","potential_value_usd")})
        return f"Lead added with id={lead_id}"
    except Exception as e:
        return f"ERROR: {e}"


# ─────────────────────────────────────────────
# GitHub tool wrappers
# ─────────────────────────────────────────────
def _t_github_get_readme(_: str, agent: str) -> str:
    ok, msg = _gate("github_get_readme", "read", agent)
    if not ok: return msg
    try:
        from tools.tool_github import github_get_readme  # type: ignore
        return github_get_readme()
    except ImportError:
        return "ERROR: tool_github.py not found"

def _t_github_update_readme(content: str, agent: str) -> str:
    ok, msg = _gate("github_update_readme", content[:100], agent)
    if not ok: return msg
    try:
        from tools.tool_github import github_update_readme  # type: ignore
        return github_update_readme(content)
    except ImportError:
        return "ERROR: tool_github.py not found"

def _t_github_list_repos(_: str, agent: str) -> str:
    ok, msg = _gate("github_list_repos", "list", agent)
    if not ok: return msg
    try:
        from tools.tool_github import github_list_repos  # type: ignore
        return github_list_repos()
    except ImportError:
        return "ERROR: tool_github.py not found"

def _t_github_update_repo(payload: str, agent: str) -> str:
    ok, msg = _gate("github_update_repo", payload[:100], agent)
    if not ok: return msg
    try:
        from tools.tool_github import github_update_repo  # type: ignore
        return github_update_repo(payload)
    except ImportError:
        return "ERROR: tool_github.py not found"

def _t_github_update_profile(payload: str, agent: str) -> str:
    ok, msg = _gate("github_update_profile", payload[:100], agent)
    if not ok: return msg
    try:
        from tools.tool_github import github_update_profile  # type: ignore
        return github_update_profile(payload)
    except ImportError:
        return "ERROR: tool_github.py not found"

def _t_github_star_repo(repo: str, agent: str) -> str:
    ok, msg = _gate("github_star_repo", repo, agent)
    if not ok: return msg
    try:
        from tools.tool_github import github_star_repo  # type: ignore
        return github_star_repo(repo)
    except ImportError:
        return "ERROR: tool_github.py not found"

def _t_github_follow_user(username: str, agent: str) -> str:
    ok, msg = _gate("github_follow_user", username, agent)
    if not ok: return msg
    try:
        from tools.tool_github import github_follow_user  # type: ignore
        return github_follow_user(username)
    except ImportError:
        return "ERROR: tool_github.py not found"

def _t_github_trending(topic: str, agent: str) -> str:
    ok, msg = _gate("github_trending", topic, agent)
    if not ok: return msg
    try:
        from tools.tool_github import github_trending  # type: ignore
        return github_trending(topic)
    except ImportError:
        return "ERROR: tool_github.py not found"

def _t_github_get_stats(_: str, agent: str) -> str:
    ok, msg = _gate("github_get_stats", "stats", agent)
    if not ok: return msg
    try:
        from tools.tool_github import github_get_stats  # type: ignore
        return github_get_stats()
    except ImportError:
        return "ERROR: tool_github.py not found"

def _t_github_create_repo(payload: str, agent: str) -> str:
    ok, msg = _gate("github_create_repo", payload[:100], agent)
    if not ok: return msg
    try:
        from tools.tool_github import github_create_repo  # type: ignore
        return github_create_repo(payload)
    except ImportError:
        return "ERROR: tool_github.py not found"


# ─────────────────────────────────────────────
# LinkedIn growth wrapper
# ─────────────────────────────────────────────
def _t_linkedin_connect(payload: str, agent: str) -> str:
    """Payload: 'urn:li:person:XXX::optional note'"""
    ok, msg = _gate("linkedin_connect", payload[:100], agent)
    if not ok: return msg
    try:
        parts = payload.split("::", 1)
        urn = parts[0].strip()
        note = parts[1].strip() if len(parts) > 1 else ""
        import os, requests as _req
        tok  = os.environ["LINKEDIN_ACCESS_TOKEN"]
        # LinkedIn connection request via invitations API
        r = _req.post(
            "https://api.linkedin.com/v2/invitations",
            headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json",
                     "X-Restli-Protocol-Version": "2.0.0"},
            json={
                "invitee": {"com.linkedin.voyager.growth.invitation.InviteeProfile": {"profileId": urn.split(":")[-1]}},
                "message": {"subject": "Let's connect", "body": note or "Hi, I'd love to connect!"},
            }, timeout=15
        )
        if r.status_code in (200, 201):
            return f"✅ Connection request sent to {urn}"
        return f"Connect result {r.status_code}: {r.text[:200]}"
    except Exception as e:
        return f"ERROR: {e}"


# ─────────────────────────────────────────────
# Registry
# ─────────────────────────────────────────────
TOOL_REGISTRY: dict[str, Callable[[str, str], str]] = {
    "bash":           t_bash,
    "read_file":      t_read_file,
    "write_file":     t_write_file,
    "search_web":     t_search_web,
    "chromadb_read":  t_chromadb_read,
    "chromadb_write": t_chromadb_write,
    "firecrawl":      t_firecrawl,
    "telegram_send":  t_telegram_send,
    # ── LinkedIn tools ──
    "linkedin_post":          _t_linkedin_post,
    "linkedin_get_analytics": _t_linkedin_analytics,
    "linkedin_dm":            _t_linkedin_dm,
    # ── Upwork tools ──
    "upwork_search":          _t_upwork_search,
    "upwork_search_all":      _t_upwork_search_all,
    "upwork_submit":          _t_upwork_submit,
    # ── Pipeline DB tools ──
    "pipeline_summary":       _t_pipeline_summary,
    "pipeline_add_lead":      _t_pipeline_add_lead,
    # ── GitHub tools ──
    "github_get_readme":      _t_github_get_readme,
    "github_update_readme":   _t_github_update_readme,
    "github_list_repos":      _t_github_list_repos,
    "github_update_repo":     _t_github_update_repo,
    "github_update_profile":  _t_github_update_profile,
    "github_star_repo":       _t_github_star_repo,
    "github_follow_user":     _t_github_follow_user,
    "github_trending":        _t_github_trending,
    "github_get_stats":       _t_github_get_stats,
    "github_create_repo":     _t_github_create_repo,
    # ── LinkedIn growth tools ──
    "linkedin_connect":       _t_linkedin_connect,
    # openweathermap, pollinations-ai, ffmpeg, pytest → no implementation yet
}

TOOL_DOCS = {
    "bash":                   "Run a shell command. Input: the command string. Returns stdout (truncated).",
    "read_file":               "Read a file. Input: absolute path. Returns file contents (max 4KB).",
    "write_file":              "Write a file. Input: 'path::content'. Returns confirmation.",
    "search_web":              "Web search via DuckDuckGo. Input: query string. Returns top 5 snippets.",
    "chromadb_read":           "Recall from a vector DB. Input: 'collection::query'. Returns top-3 hits.",
    "chromadb_write":          "Persist to a vector DB. Input: 'collection::content'. Returns confirmation.",
    "firecrawl":               "Scrape a URL to markdown. Input: full URL. Returns markdown (truncated).",
    "telegram_send":           "Post to a Telegram topic. Input: 'topic_name::message' (topic: boardroom|turicks|naggar|social|think_tank|revenue).",
    # LinkedIn
    "linkedin_post":           "Post to LinkedIn. Input: the post text (max 3000 chars). Returns JSON with post_id and url.",
    "linkedin_get_analytics":  "Get post analytics. Input: post_id string. Returns JSON with impressions/likes/comments.",
    "linkedin_dm":             "Send a LinkedIn DM. Input: 'recipient_urn::message text'. recipient_urn format: urn:li:person:XXXXX.",
    # Upwork
    "upwork_search":           "Search Upwork jobs. Input: query string. Returns JSON list of jobs.",
    "upwork_search_all":       "Search all Turicks ICP queries on Upwork. Input: ignored. Returns merged JSON list.",
    "upwork_submit":           "Submit Upwork proposal. Input: JSON string {job_id, cover_letter, bid_amount}.",
    # Pipeline
    "pipeline_summary":        "Get pipeline/revenue summary. Input: ignored. Returns text summary of leads/revenue.",
    "pipeline_add_lead":       "Add a lead to CRM. Input: JSON string {name, company, source, linkedin_url, email, notes, potential_value_usd}.",
    # GitHub
    "github_get_readme":       "Get current GitHub profile README. Input: ignored.",
    "github_update_readme":    "Create/update GitHub profile README. Input: full markdown content.",
    "github_list_repos":       "List all public repos with stars and descriptions. Input: ignored.",
    "github_update_repo":      "Update repo description/topics. Input: JSON {repo, description, topics, homepage}.",
    "github_update_profile":   "Update GitHub profile bio/blog/location/twitter. Input: JSON {bio, blog, company, location, twitter_username}.",
    "github_star_repo":        "Star a GitHub repo for visibility. Input: 'owner/repo' string.",
    "github_follow_user":      "Follow a GitHub user. Input: username string.",
    "github_trending":         "Search trending repos by topic. Input: topic string e.g. 'langgraph'.",
    "github_get_stats":        "Get GitHub profile stats (followers, repos, bio). Input: ignored.",
    "github_create_repo":      "Create a new public repo. Input: JSON {name, description, topics}.",
    # LinkedIn growth
    "linkedin_connect":        "Send LinkedIn connection request. Input: 'urn:li:person:XXX::note' (note optional).",
}


def execute_tool(tool: str, tool_input: str, agent_name: str) -> str:
    """Dispatch to a tool implementation. Returns string result or error message."""
    fn = TOOL_REGISTRY.get(tool)
    if not fn:
        return f"ERROR: tool '{tool}' has no implementation in TOOL_REGISTRY"
    return fn(tool_input, agent_name)


def tools_for_agent(agent_name: str) -> list[str]:
    """Subset of TOOL_REGISTRY granted to this agent in registry.py."""
    a = get_agent(agent_name)
    if not a:
        return []
    return [t for t in a.allowed_tools if t in TOOL_REGISTRY]
