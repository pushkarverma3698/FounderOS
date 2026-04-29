"""
FounderOS — Central System Registry
====================================
Single Source of Truth for Companies, Agents, and Routing.

This file completely removes hardcoded strings like "turicks" and "naggar"
from the rest of the FounderOS codebase. Adding a new company or agent
requires modifying ONLY this file.

Functions:
- `get_company(name)`
- `get_all_companies()`
- `get_agent(name)`
- `get_all_agents()`
"""

import os
from dataclasses import dataclass, field
from typing import List, Dict, Optional

# ════════════════════════════════════════════════════════════════════════════════
# CORE DATA MODELS
# ════════════════════════════════════════════════════════════════════════════════

@dataclass
class Company:
    name: str                       # e.g., "turicks", "naggar"
    readable_name: str              # e.g., "Turicks (AI Agency)"
    memory_collection: str          # e.g., "turicks_mem"
    telegram_topic_id: int          # Target route for notifications
    profile: dict                   # Detailed context available to agents
    agents: List[str] = field(default_factory=list)

@dataclass
class Agent:
    name: str                       # e.g., "bidding_sniper"
    company_assignment: str         # "turicks", "naggar", "cross"
    cascade_tier: str               # "ceo", "deep_research", "md", "nano", "local", "video"
    allowed_collections: List[str]  # e.g., ["turicks_mem", "social_mem"]
    allowed_tools: List[str] = field(default_factory=lambda: ["bash", "read_file", "search_web"]) # Baseline safety


# ════════════════════════════════════════════════════════════════════════════════
# COMPANY CONFIGURATIONS
# ════════════════════════════════════════════════════════════════════════════════
# Note: Topic IDs fallback to 0 if not set in environment.

_COMPANIES = {
    "turicks": Company(
        name="turicks",
        readable_name="Turicks (AI Agency)",
        memory_collection="turicks_mem",
        telegram_topic_id=int(os.getenv("TOPIC_TURICKS", "0")),
        profile={
            "services": ["LangGraph agentic systems", "Next.js", "MERN", "AI automation"],
            "website": "https://turicks.com",
            "pricing": "$500 starter → $5,000 retainer",
            "target_geo": ["EU", "US"],
            "icp": "SME founders $50K-500K ARR needs AI/automation",
            "differentiator": "3-5 day delivery, working code not prototypes, value-driven"
        }
    ),
    "naggar": Company(
        name="naggar",
        readable_name="Naggar Retreat (Himalayan Farm)",
        memory_collection="naggar_mem",
        telegram_topic_id=int(os.getenv("TOPIC_NAGGAR", "0")),
        profile={
            "type": "Himalayan farm + premium homestay",
            "location": "Naggar, HP | Alt: 1768m | Lat: 31.99, Lon: 77.17",
            "produce": ["raspberries", "apples", "walnuts"],
            "base_rate": "₹6,000/night",
            "booking_platforms": ["Airbnb", "Booking.com", "Direct"],
            "brand": "Ahata — farm-to-table culinary experiences"
        }
    ),
    "cross": Company(
        name="cross",
        readable_name="FounderOS Cross-Company",
        memory_collection="social_mem", # Shared generalized memory
        telegram_topic_id=int(os.getenv("TOPIC_BOARDROOM", "0")),
        profile={
            "type": "System orchestration and cross-domain management",
            "mission": "Maintain agent health, research broad topics, optimize overall cost."
        }
    )
}

# ════════════════════════════════════════════════════════════════════════════════
# AGENT CONFIGURATIONS
# ════════════════════════════════════════════════════════════════════════════════

_AGENTS_DB = [
    # ── Turicks Agents ──
    # chromadb_read: recall context | chromadb_write: store results
    Agent("bidding_sniper",  "turicks", "code",  ["turicks_mem"], ["bash", "read_file", "search_web", "chromadb_read", "chromadb_write", "upwork_search", "upwork_search_all", "upwork_submit", "pipeline_add_lead"]),
    Agent("lead_intel",      "turicks", "local", ["turicks_mem"], ["bash", "read_file", "search_web", "chromadb_read", "chromadb_write", "firecrawl"]),
    Agent("senior_dev",      "turicks", "code",  ["turicks_mem"], ["bash", "read_file", "write_file", "search_web", "chromadb_read", "chromadb_write", "github_mcp"]),
    Agent("vibe_coder",      "turicks", "local", ["turicks_mem"], ["bash", "read_file", "write_file", "search_web", "chromadb_read", "chromadb_write", "github_mcp"]),
    Agent("qa_tester",       "turicks", "local", ["turicks_mem"], ["bash", "read_file", "search_web", "chromadb_read", "pytest"]),
    Agent("proposal_writer", "turicks", "md",    ["turicks_mem"], ["bash", "read_file", "write_file", "search_web", "chromadb_read", "chromadb_write"]),
    Agent("ops_agent",       "turicks", "nano",  ["turicks_mem"], ["bash", "read_file", "search_web", "chromadb_read", "telegram_send"]),
    Agent("kb_agent",        "turicks", "local", ["turicks_mem"], ["bash", "read_file", "write_file", "chromadb_read", "chromadb_write"]),
    Agent("web_designer",    "turicks", "md",    ["turicks_mem"], ["bash", "read_file", "write_file", "search_web", "chromadb_read", "chromadb_write"]),
    Agent("seo_specialist",  "turicks", "deep_research", ["turicks_mem"], ["bash", "read_file", "search_web", "chromadb_read", "chromadb_write", "firecrawl"]),

    # ── Naggar Agents ──
    Agent("farm_weather",      "naggar", "local", ["naggar_mem"], ["bash", "read_file", "search_web", "chromadb_read", "chromadb_write", "openweathermap"]),
    Agent("yield_scout",       "naggar", "local", ["naggar_mem"], ["bash", "read_file", "search_web", "chromadb_read", "chromadb_write"]),
    Agent("booking_concierge", "naggar", "nano",  ["naggar_mem"], ["bash", "read_file", "chromadb_read", "chromadb_write", "telegram_send"]),
    Agent("vibe_designer",     "naggar", "md",    ["naggar_mem"], ["bash", "read_file", "write_file", "search_web", "chromadb_read", "chromadb_write"]),
    Agent("culinary_agent",    "naggar", "local", ["naggar_mem"], ["bash", "read_file", "search_web", "chromadb_read", "chromadb_write"]),
    Agent("market_scout",      "naggar", "deep_research", ["naggar_mem", "social_mem"], ["bash", "read_file", "search_web", "chromadb_read", "chromadb_write", "firecrawl"]),
    Agent("guest_crm",         "naggar", "local", ["naggar_mem"], ["bash", "read_file", "write_file", "chromadb_read", "chromadb_write"]),
    Agent("naggar_kb",         "naggar", "local", ["naggar_mem"], ["bash", "read_file", "write_file", "chromadb_read", "chromadb_write"]),
    Agent("video_editor",      "naggar", "video", ["naggar_mem"], ["bash", "read_file", "chromadb_read", "ffmpeg"]),

    # ── Turicks: GitHub agent ──
    Agent("github_agent",      "turicks", "md",   ["turicks_mem", "social_mem"], ["bash", "read_file", "write_file", "search_web", "chromadb_read", "chromadb_write", "telegram_send", "github_get_readme", "github_update_readme", "github_list_repos", "github_update_repo", "github_update_profile", "github_star_repo", "github_follow_user", "github_trending", "github_get_stats", "github_create_repo"]),

    # ── Cross-Company Agents ──
    Agent("social_researcher", "cross", "deep_research", ["social_mem"], ["bash", "read_file", "search_web", "chromadb_read", "chromadb_write", "firecrawl"]),
    Agent("social_handler",    "cross", "md",    ["social_mem"], ["bash", "read_file", "write_file", "search_web", "chromadb_read", "chromadb_write", "telegram_send", "linkedin_post", "linkedin_get_analytics"]),
    Agent("platform_growth",   "cross", "deep_research", ["social_mem", "turicks_mem"], ["bash", "read_file", "search_web", "chromadb_read", "chromadb_write", "telegram_send", "firecrawl", "linkedin_connect", "github_star_repo", "github_follow_user", "github_trending"]),
    Agent("linkedin_growth",   "cross", "md",    ["social_mem"], ["bash", "read_file", "search_web", "chromadb_read", "chromadb_write", "telegram_send", "linkedin_post", "linkedin_connect", "linkedin_dm", "firecrawl"]),
    Agent("cost_watchdog",     "cross", "md",    ["turicks_mem", "naggar_mem", "social_mem"], ["bash", "read_file", "chromadb_read", "chromadb_write"]),
    Agent("team_therapist",    "cross", "md",    ["turicks_mem", "naggar_mem", "social_mem"], ["bash", "read_file", "chromadb_read", "chromadb_write", "telegram_send"]),
    Agent("hr_agent",          "cross", "deep_research", ["turicks_mem", "naggar_mem", "social_mem"], ["bash", "read_file", "search_web", "chromadb_read", "chromadb_write"]),
    Agent("revenue_scout",     "cross", "deep_research", ["turicks_mem", "social_mem"], ["bash", "read_file", "search_web", "chromadb_read", "chromadb_write"]),
    Agent("outreach_agent",    "cross", "md",    ["turicks_mem", "social_mem"], ["bash", "read_file", "write_file", "search_web", "chromadb_read", "chromadb_write", "telegram_send", "firecrawl", "linkedin_dm", "pipeline_add_lead"]),
    Agent("pipeline_md",       "cross", "md",    ["turicks_mem", "social_mem"], ["bash", "read_file", "search_web", "chromadb_read", "chromadb_write", "telegram_send", "pipeline_summary"]),
    Agent("scrum_engine",      "cross", "nano",  ["turicks_mem", "naggar_mem", "social_mem"], ["bash", "read_file", "chromadb_read", "chromadb_write", "telegram_send"]),
    Agent("scrum_pm",          "cross", "md",    ["turicks_mem", "naggar_mem", "social_mem"], ["bash", "read_file", "chromadb_read", "chromadb_write", "telegram_send"]),

    # ── JobOS V2: Personal Job Finding Agents ──
    Agent("job_coordinator",       "cross", "ceo",          ["social_mem"], ["bash", "read_file", "write_file", "telegram_send"]),
    Agent("job_intel",             "cross", "code",          ["social_mem"], ["bash", "read_file", "search_web", "firecrawl"]),
    Agent("ats_optimizer",         "cross", "md",            ["social_mem"], ["bash", "read_file", "write_file"]),
    Agent("cover_letter_writer",   "cross", "md",            ["social_mem"], ["bash", "read_file", "write_file"]),
    Agent("outreach_agent_personal","cross", "md",           ["social_mem"], ["bash", "read_file", "telegram_send"]),

    # ── JobOS V3: Advanced Career Engine ──
    Agent("resume_tailor",         "cross", "md",            ["social_mem"], ["bash", "read_file", "write_file"]),
    Agent("lead_monitor",          "cross", "nano",          ["social_mem"], ["bash", "read_file", "search_web"]),
    Agent("interview_researcher",  "cross", "deep_research", ["social_mem"], ["bash", "read_file", "search_web"]),
    Agent("hr_scout",              "cross", "deep_research", ["social_mem"], ["bash", "read_file", "search_web"]),
    Agent("liaison_agent",         "cross", "md",            ["social_mem", "career_mem"], ["bash", "read_file", "telegram_send"]),
]

_AGENTS = {a.name: a for a in _AGENTS_DB}

# Populate backlinks from Agent -> Company
for agent in _AGENTS_DB:
    if agent.company_assignment in _COMPANIES:
        _COMPANIES[agent.company_assignment].agents.append(agent.name)


# ════════════════════════════════════════════════════════════════════════════════
# ACCESSOR METHODS
# ════════════════════════════════════════════════════════════════════════════════

def get_company(name: str) -> Optional[Company]:
    """Get company configuration by its identifier."""
    return _COMPANIES.get(name)

def get_all_companies() -> List[Company]:
    """List of all valid operating companies (omits 'cross')."""
    return [c for c in _COMPANIES.values() if c.name != "cross"]

def get_agent(name: str) -> Optional[Agent]:
    """Get agent configuration by its identifier."""
    return _AGENTS.get(name)

def get_all_agents() -> List[Agent]:
    """List of all registered agents."""
    return list(_AGENTS.values())

def get_agents_for_company(company_name: str) -> List[Agent]:
    """Get all agents assigned to a specific company."""
    company = get_company(company_name)
    if not company:
        return []
    agents = [get_agent(name) for name in company.agents]
    return [a for a in agents if a is not None]

def get_agent_topic_id(agent_name: str) -> int:
    """Helper to dynamically resolve which Telegram topic an agent reports to."""
    agent = get_agent(agent_name)
    if not agent or agent.company_assignment not in _COMPANIES:
        # Default fallback topic 
        return int(os.getenv("TOPIC_BOARDROOM", "0"))
    
    # Specific agents might override this if needed, else fallback to company topic
    # For cross agents, social goes to Think Tank, rest normally Boardroom
    if agent.company_assignment == "cross":
        if "social" in agent_name:
            return int(os.getenv("TOPIC_THINK_TANK", "0"))
        
    return _COMPANIES[agent.company_assignment].telegram_topic_id
