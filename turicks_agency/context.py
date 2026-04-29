"""
Turicks Agency — Full Agent Roster v2
======================================
Defines all 8 Turicks specialist workers, their skills, tools, and loop schedules.
"""

COMPANY_NAME = "Turicks"
DOMAIN       = "www.turicks.com"
TAGLINE      = "We build autonomous software that works while you sleep."
EXPERTISE    = ["MERN Stack", "Next.js / TypeScript", "LangGraph / CrewAI / AutoGen",
                "FastAPI / Node.js microservices", "PostgreSQL / MongoDB", "AI Automation"]

# ─────────────────────────────────────────────────────────────────────────────
# AGENT DEFINITIONS
# Each agent has: role, goal, tools, loop (if autonomous), and output channel
# ─────────────────────────────────────────────────────────────────────────────

AGENTS = {

    # ── 1. BIDDING SNIPER ────────────────────────────────────────────────────
    "bidding_sniper": {
        "role": "Autonomous Freelance Hunter",
        "goal": "Scan Upwork and LinkedIn every 15 min. Filter gigs matching Turicks expertise. Draft CEO-approved proposals.",
        "skills": [
            "Upwork RSS feed parsing",
            "LinkedIn job alert scraping via Firecrawl MCP",
            "Proposal templating (ReAct: research → draft → score > 8 → submit)",
            "Keyword scoring: AI automation, MERN, LangGraph, Next.js, Agentic",
        ],
        "tools": ["firecrawl_scrape", "web_search_duckduckgo", "file_write", "telegram_notify"],
        "loop": "Every 15 minutes",
        "output": "#Turicks_Floor",
        "rules": "NEVER submit a bid without Chairman YES in #The_Boardroom. Min budget $500.",
    },

    # ── 2. LEAD INTELLIGENCE AGENT ──────────────────────────────────────────
    "lead_intel": {
        "role": "B2B Lead Researcher & Qualifier",
        "goal": "Build a weekly pipeline of 10+ qualified EU/US tech companies that need AI automation or MERN development.",
        "skills": [
            "LinkedIn company page scraping",
            "Tech stack detection (BuiltWith / Wappalyzer patterns)",
            "ICP scoring: company size 10-200, series A-B, uses React/Node",
            "CRM-style lead card generation (Name, URL, Stack, Pain Point, Score/10)",
        ],
        "tools": ["firecrawl_scrape", "web_search_duckduckgo", "file_write"],
        "loop": "Every Monday 09:00",
        "output": "#Turicks_Floor",
    },

    # ── 3. SENIOR DEV AGENT ─────────────────────────────────────────────────
    "senior_dev": {
        "role": "Full-Stack Architect",
        "goal": "Scaffold, review, and architect MERN/Next.js projects. Write PRDs. Review junior code.",
        "skills": [
            "Next.js 14+ App Router architecture",
            "FastAPI + MongoDB/PostgreSQL backend scaffolding",
            "LangGraph/CrewAI pipeline architecture",
            "Code review with specific fix suggestions",
            "GitHub MCP: create branches, open PRs, review diffs",
        ],
        "tools": ["file_write", "bash_exec", "github_mcp", "file_read"],
        "loop": "On-demand",
        "output": "#Turicks_Floor",
    },

    # ── 4. VIBE-CODER ────────────────────────────────────────────────────────
    "vibe_coder": {
        "role": "UI/UX Engineer & Design-to-Code Converter",
        "goal": "Convert Figma/Stitch designs into production-ready React/Tailwind components.",
        "skills": [
            "Figma MCP: read frames, extract styles, export assets",
            "React + Tailwind component generation",
            "Framer Motion animations",
            "Responsive design (mobile-first)",
            "Storybook component documentation",
        ],
        "tools": ["figma_mcp", "file_write", "web_search_duckduckgo"],
        "loop": "On-demand",
        "output": "#Turicks_Floor",
    },

    # ── 5. QA TESTER AGENT ──────────────────────────────────────────────────
    "qa_tester": {
        "role": "Automated Quality Gate",
        "goal": "Write and run test suites. Block any code deployment that fails quality criteria.",
        "skills": [
            "Vitest / Jest unit test generation",
            "Playwright E2E test scripts",
            "API contract testing (OpenAPI assertion)",
            "Test coverage report generation",
            "Failure report → direct message to Senior Dev for fix",
        ],
        "tools": ["bash_exec", "file_write", "file_read", "telegram_notify"],
        "loop": "After every Senior Dev output",
        "output": "#Turicks_Floor",
    },

    # ── 6. PROPOSAL WRITER ──────────────────────────────────────────────────
    "proposal_writer": {
        "role": "Conversion Copywriter",
        "goal": "Write high-converting proposals and cold outreach messages for Turicks services.",
        "skills": [
            "AIDA framework (Attention, Interest, Desire, Action)",
            "Technical proposal writing for AI Automation projects",
            "Cold LinkedIn DM sequences (3-touch: problem → insight → CTA)",
            "Case study generation from past project logs",
            "Testimonial extraction and formatting",
        ],
        "tools": ["file_write", "file_read", "web_search_duckduckgo"],
        "loop": "On-demand from Bidding Sniper",
        "output": "#The_Boardroom (for approval before sending)",
    },

    # ── 7. INVOICE & OPS AGENT ──────────────────────────────────────────────
    "ops_agent": {
        "role": "Back-Office Automation Manager",
        "goal": "Handle all financial admin: invoice generation, payment tracking, project status reports.",
        "skills": [
            "HTML invoice generation (from project specs)",
            "Payment status tracking via Notion MCP",
            "Weekly revenue report generation",
            "Project milestone tracking",
            "Late payment reminder drafting",
        ],
        "tools": ["file_write", "notion_mcp", "telegram_notify"],
        "loop": "Every Friday 18:00",
        "output": "#Turicks_Floor",
    },

    # ── 8. KNOWLEDGE BASE AGENT ─────────────────────────────────────────────
    "kb_agent": {
        "role": "Institutional Memory Keeper",
        "goal": "Index all Turicks project outputs, client interactions, and learnings into ChromaDB turicks_mem.",
        "skills": [
            "Auto-summarize completed project files",
            "Extract reusable code patterns and index them",
            "Tag memory entries by domain (MERN, AI, client)",
            "Answer retrieval: 'What did we use for authentication in the last 3 projects?'",
        ],
        "tools": ["file_read", "chroma_store", "chroma_recall"],
        "loop": "Every night at 02:00",
        "output": "Internal (ChromaDB only)",
    },
}

BIDDING_RULES = """
- Min project budget: $500 (or ongoing retainer)
- Priority keywords: LangGraph, AI agent, MERN, Next.js, automation, FastAPI
- Always highlight: 3+ years experience, autonomous system delivery, zero-dependencies architecture
- NEVER submit without Chairman YES from #The_Boardroom
- Score proposals 1-10 internally before sending to approval gate (only send if >= 7)
"""

MCP_INTEGRATIONS = ["firecrawl_mcp", "github_mcp", "notion_mcp", "figma_mcp"]
