"""
Naggar Retreat — Full Agent Roster v2
=======================================
Defines all 8 Naggar Retreat specialist workers, their skills, tools, and autonomous loops.
"""

COMPANY_NAME = "Naggar Retreat"
LOCATION     = "Naggar, Kullu District, Himachal Pradesh, India (Altitude: ~1768m)"
TAGLINE      = "Farm-to-table living in the heart of the Himalayas."

BUSINESSES = {
    "raspberry_farm": "Seasonal raspberry cultivation. Target exports: Dutch/EU wholesale market.",
    "himalayan_homestay": "6-room boutique homestay. Platforms: Airbnb, Booking.com, direct.",
    "ahata_culinary": "North Indian culinary brand. Costing, menu math, food styling content.",
    "vibe_marketing": "Aesthetic content brand. Instagram Reels, Substack, Pinterest boards.",
}

# ─────────────────────────────────────────────────────────────────────────────
# AGENT DEFINITIONS
# ─────────────────────────────────────────────────────────────────────────────

AGENTS = {

    # ── 1. FARM WEATHER AGENT ────────────────────────────────────────────────
    "farm_weather": {
        "role": "Precision Farm Meteorologist",
        "goal": "Deliver hyper-local daily weather briefings and frost/hail alerts for Naggar's micro-climate.",
        "skills": [
            "OpenWeatherMap API integration (lat: 31.99, lon: 77.17)",
            "HP State Horticulture Dept advisory parsing",
            "7-day forecast with raspberry-specific risk flags (frost < 2°C, rain > 20mm)",
            "Irrigation scheduling based on soil moisture estimates",
            "Frost alert → WhatsApp/Telegram emergency push",
        ],
        "tools": ["web_search_duckduckgo", "http_get", "telegram_notify", "file_write"],
        "loop": "Daily 05:45 AM (before sunrise)",
        "output": "#Naggar_HQ",
    },

    # ── 2. YIELD PROJECTION AGENT ────────────────────────────────────────────
    "yield_scout": {
        "role": "Crop Intelligence & Export Strategist",
        "goal": "Track raspberry growth stage, project weekly yield, and match against Dutch/EU wholesale prices.",
        "skills": [
            "Raspberry phenology stage calendar (flowering → fruiting → harvest)",
            "Yield模型: GDD (Growing Degree Days) calculation",
            "Dutch market price scraping: Freshplaza, GroentenFruit Huis",
            "Export logistics research: cold chain, packaging specs for EU",
            "Weekly P&L estimate: projected kg × market price − costs",
        ],
        "tools": ["web_search_duckduckgo", "firecrawl_scrape", "file_write", "chroma_store"],
        "loop": "Every Monday + Thursday 08:00",
        "output": "#Naggar_HQ",
    },

    # ── 3. BOOKING CONCIERGE ─────────────────────────────────────────────────
    "booking_concierge": {
        "role": "Guest Experience & Revenue Manager",
        "goal": "Monitor bookings, draft personalised welcome messages, manage calendar conflicts, optimise pricing.",
        "skills": [
            "Airbnb / Booking.com message template generation",
            "Dynamic pricing recommendation (peak: May-June, Oct, Dec-Jan)",
            "Guest FAQ auto-response (check-in, food, trek routes, taxi)",
            "Post-stay review request sequence (3-touch: day 1, day 3, day 7)",
            "Calendar gap detection → send discount offer to past guests",
        ],
        "tools": ["file_write", "telegram_notify", "web_search_duckduckgo"],
        "loop": "Daily 09:00 (check new bookings) + On-demand",
        "output": "#Naggar_HQ",
    },

    # ── 4. VIBE CONTENT DESIGNER ─────────────────────────────────────────────
    "vibe_designer": {
        "role": "Aesthetic Content Strategist & Creator",
        "goal": "Produce 3 pieces of publish-ready content per week for Naggar Retreat's Instagram, Substack, and Pinterest.",
        "skills": [
            "Instagram Reel script writing (hook → story → CTA in 30s)",
            "Substack newsletter drafting (weekly 'Letters from Naggar')",
            "Pinterest board curation: Himalayan aesthetic, slow living, farm-to-table",
            "Content calendar management (seasonal: harvest → snow → blossom)",
            "Hashtag research: #NaggarValley #HimachalLife #SlowLiving #FarmToTable",
            "Brand voice: warm, slow, poetic. Never corporate.",
        ],
        "tools": ["file_write", "web_search_duckduckgo", "image_generate"],
        "loop": "Monday, Wednesday, Friday 10:00",
        "output": "#Naggar_HQ",
    },

    # ── 5. AHATA CULINARY AGENT ──────────────────────────────────────────────
    "culinary_agent": {
        "role": "Recipe Engineer & Menu Mathematician",
        "goal": "Maintain accurate food costing, develop seasonal menus, and create content around the Ahata culinary brand.",
        "skills": [
            "Ingredient cost database (local Naggar market prices)",
            "Menu costing: food cost % = ingredient cost / selling price",
            "Seasonal menu planning linked to farm yield projections",
            "Recipe content: step-by-step with Himalayan context stories",
            "Pricing suggestion: target food cost 28-32%",
        ],
        "tools": ["file_write", "file_read", "web_search_duckduckgo"],
        "loop": "Monthly menu review + On-demand",
        "output": "#Naggar_HQ",
    },

    # ── 6. MARKET RESEARCH AGENT ─────────────────────────────────────────────
    "market_scout": {
        "role": "Agricultural & Hospitality Intelligence Analyst",
        "goal": "Monitor competitor pricing, Himachal homestay trends, EU berry import regulations, and agri-tourism opportunities.",
        "skills": [
            "Himachal homestay competitor analysis (Airbnb comps within 20km)",
            "HP Govt subsidy scheme monitoring (MIDH horticulture schemes)",
            "EU food import regulation tracking (pesticide residue limits for raspberries)",
            "Agri-tourism grant research (State and National level)",
            "Monthly 'Market Intelligence Report' generation",
        ],
        "tools": ["web_search_duckduckgo", "firecrawl_scrape", "file_write"],
        "loop": "Every 2 weeks",
        "output": "#The_Think_Tank + #Naggar_HQ",
    },

    # ── 7. GUEST CRM AGENT ───────────────────────────────────────────────────
    "guest_crm": {
        "role": "Relationship & Loyalty Manager",
        "goal": "Maintain a guest database. Nurture past guests into repeat visitors with personalised seasonal updates.",
        "skills": [
            "Guest profile indexing in ChromaDB naggar_mem (stay dates, preferences, origin)",
            "Seasonal re-engagement campaigns (Blossom season invite, harvest experience)",
            "Referral program: 'Bring a friend, get 10% off' automated sequence",
            "WhatsApp/Telegram broadcast drafts for seasonal offers",
            "Guest sentiment analysis from reviews → property improvement suggestions",
        ],
        "tools": ["chroma_store", "chroma_recall", "file_write", "telegram_notify"],
        "loop": "Monthly re-engagement + after every checkout",
        "output": "#Naggar_HQ",
    },

    # ── 8. KNOWLEDGE BASE AGENT ─────────────────────────────────────────────
    "naggar_kb": {
        "role": "Farm & Business Memory Keeper",
        "goal": "Index all farm logs, guest interactions, recipes, and market research into ChromaDB naggar_mem.",
        "skills": [
            "Daily farm log ingestion (weather + yield notes → ChromaDB)",
            "Guest review sentiment tagging",
            "Recipe and costing data versioning",
            "Answer: 'What was our raspberry yield in June last year?'",
        ],
        "tools": ["file_read", "chroma_store", "chroma_recall"],
        "loop": "Daily at 23:00",
        "output": "Internal (ChromaDB only)",
    },
}

MCP_INTEGRATIONS = ["firecrawl_mcp", "notion_mcp"]

FARM_SCHEDULE = """
05:45  Farm Weather Agent → weather briefing to #Naggar_HQ
06:00  Irrigation schedule issued (if dry forecast)
08:00  (Mon/Thu) Yield Scout → market price vs yield report
09:00  Booking Concierge → check new reservations
10:00  (MWF) Vibe Designer → content draft ready for review
23:00  Naggar KB Agent → index day's logs into ChromaDB
"""
