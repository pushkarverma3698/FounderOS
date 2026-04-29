"""
FounderOS — NotebookLM Strategic Intelligence Bridge
=====================================================
NotebookLM acts as the "Executive Strategy Suite" — the high-level layer
above ChromaDB where your agents synthesize curated documents into:
  - Strategic reports (market intelligence, competitor analysis)  
  - Audio Overviews (podcast-style briefings from dry data)
  - Slide deck outlines and investor-ready infographics
  - Interactive Q&A against your business documents

Architecture:
  ChromaDB (active agent memory + auto-research)
       ↓ exports daily digests
  NotebookLM Notebooks (strategic synthesis layer)
       ↓ produces
  Reports / Audio / Slides → exported to ~/Documents/Coding stuff/FounderOS/strategic_output/
       ↓ summary posted to
  #The_Think_Tank (Telegram)

Since NotebookLM doesn't have a public API, this module:
  1. Prepares perfectly-formatted source documents for manual upload
  2. Generates structured NotebookLM query prompts you can paste directly
  3. Uses Gemini 1.5 Pro ("NotebookLM quality") for API-accessible deep research
  4. Formats outputs as NotebookLM-compatible markdown for import

Two Notebooks to maintain:
  - 🏢 Turicks Notebook: proposals, client briefs, dev logs, market reports
  - 🌿 Naggar Notebook: farm logs, weather history, competitor homestays, recipes
"""

import sys, os, logging
from pathlib import Path
from datetime import date, datetime
sys.path.insert(0, str(os.path.dirname(__file__)))

from core.config import BASE_DIR, TURICKS_DIR, NAGGAR_DIR, call_deep_research
from memory.memory import turicks_mem, naggar_mem, recall, cross_company_search

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("NotebookLM-Bridge")

STRATEGIC_DIR = BASE_DIR / "strategic_output"
STRATEGIC_DIR.mkdir(exist_ok=True)

(STRATEGIC_DIR / "turicks").mkdir(exist_ok=True)
(STRATEGIC_DIR / "naggar").mkdir(exist_ok=True)


# ═══════════════════════════════════════════════════════════════════════════════
# WORKFLOW 1: Deep Market Intelligence (replaces manual NotebookLM Deep Research)
# ═══════════════════════════════════════════════════════════════════════════════

def generate_market_intelligence(company: str, topic: str) -> str:
    """
    Replicates NotebookLM's Deep Research tool via Gemini 1.5 Pro.
    Pulls ChromaDB context + generates a cited, structured report.

    Example: generate_market_intelligence("naggar", "Dutch raspberry wholesale market 2026")
    """
    # Retrieve relevant context from ChromaDB
    collection = naggar_mem if company == "naggar" else turicks_mem
    memories   = recall(collection, topic, n_results=10)
    context    = "\n\n".join(memories) if memories else "No previous data found."

    prompt = f"""You are a strategic analyst producing a NotebookLM-quality market intelligence report.

Company: {company.title()}
Topic: {topic}
Date: {date.today()}

Internal data from our agent memory:
{context}

Produce a structured intelligence report with these sections:
1. Executive Summary (3 sentences max)
2. Market Overview (current state, size, key players)
3. Actionable Opportunities (3-5 specific opportunities with evidence)
4. Risk Analysis (3 key risks with mitigation)
5. Recommended Next Actions (specific, this week)
6. Sources Referenced

Format as clean markdown. Be specific. Use numbers where available. No filler content."""

    resp = call_deep_research(prompt)
    
    # Save to strategic output
    filename = f"market_intel_{company}_{date.today()}_{topic[:30].replace(' ', '_')}.md"
    filepath = STRATEGIC_DIR / company / filename
    filepath.write_text(f"# Market Intelligence: {topic}\n\n{resp}")
    log.info(f"Market report saved: {filepath.name}")
    
    return resp


# ═══════════════════════════════════════════════════════════════════════════════
# WORKFLOW 2: Competitor Gap Analysis
# ═══════════════════════════════════════════════════════════════════════════════

def generate_competitor_analysis(company: str, competitors: list[str]) -> str:
    """
    Generates a comparison table (NotebookLM Competitor Analysis workflow).
    Turicks: vs local Delhi/Bangalore agencies
    Naggar: vs Airbnb homestays in Manali/Kasol/Spiti
    """
    prompt = f"""You are a business analyst creating a competitor gap analysis for {company.title()}.

Competitors to analyze: {', '.join(competitors)}

Create:
1. A markdown comparison table with columns: Feature | Us ({company.title()}) | {competitors[0]} | {competitors[1] if len(competitors) > 1 else 'Industry Average'}
2. Our 3 clear competitive advantages (be specific)
3. Our 3 gaps to close (with action plan)
4. Pricing positioning recommendation

For Turicks: focus on AI automation capability, speed of delivery, agentic frameworks.
For Naggar: focus on authenticity, farm experience, culinary differentiation, slow living.

Be specific. Make recommendations actionable this month."""

    resp = call_deep_research(prompt)
    
    filename = f"competitor_analysis_{company}_{date.today()}.md"
    filepath = STRATEGIC_DIR / company / filename
    filepath.write_text(f"# Competitor Analysis — {company.title()}\n\n{resp}")
    
    return resp


# ═══════════════════════════════════════════════════════════════════════════════
# WORKFLOW 3: Audio Overview Brief (NotebookLM Podcast-style)
# This generates the SCRIPT for an audio briefing (to be voiced by TTS)
# ═══════════════════════════════════════════════════════════════════════════════

def generate_audio_brief(company: str, data_summary: str, briefing_type: str = "weekly") -> str:
    """
    Replicates NotebookLM's 'Audio Overview' podcast feature.
    Converts dry data/reports into a conversational 2-host podcast script.
    Can be TTS-voiced using macOS 'say' command or ElevenLabs.
    
    briefing_type: "weekly" | "quarterly" | "crisis" | "opportunity"
    """
    prompt = f"""Write a 2-host podcast script (3-4 minutes) that sounds exactly like NotebookLM's 'Audio Overview'.

Company: {company.title()}
Briefing Type: {briefing_type.title()} Intelligence Briefing
Date: {datetime.now().strftime('%B %d, %Y')}
Source Data:
{data_summary}

Format as a back-and-forth dialogue between HOST_A (analytical) and HOST_B (practical):
- HOST_A introduces the key findings
- HOST_B asks clarifying questions and draws out implications
- They end with 3 clear recommendations

Tone: intelligent, conversational, no jargon, as if talking to a smart founder.
Length: ~600 words (readable in 3-4 minutes).

Output format:
[HOST_A]: ...
[HOST_B]: ...
[HOST_A]: ..."""

    script = call_deep_research(prompt)
    
    # Save script
    filename = f"audio_brief_{company}_{briefing_type}_{date.today()}.txt"
    filepath = STRATEGIC_DIR / company / filename
    filepath.write_text(script)

    # Also generate TTS command (macOS)
    tts_cmd = f"say -v Samantha -f '{filepath}' -o '{str(filepath).replace('.txt', '.aiff')}'"
    log.info(f"Audio brief saved: {filepath.name}")
    log.info(f"Generate audio: {tts_cmd}")
    
    return script


# ═══════════════════════════════════════════════════════════════════════════════
# WORKFLOW 4: Investor / Partner Pitch Deck Outline
# ═══════════════════════════════════════════════════════════════════════════════

def generate_pitch_outline(company: str, pitch_type: str = "client proposal") -> str:
    """
    Generates a 10-14 slide pitch deck outline grounded in ChromaDB context.
    pitch_type: "client proposal" | "investor deck" | "partnership brief"
    """
    collection = naggar_mem if company == "naggar" else turicks_mem
    memories   = recall(collection, pitch_type, n_results=8)
    context    = "\n".join(memories) if memories else ""

    prompt = f"""Create a {pitch_type} slide deck outline for {company.title()}.

Internal context from past work:
{context}

Generate a 12-slide deck outline:
Slide 01: Cover — headline value proposition
Slide 02: The Problem we solve
Slide 03: Our Solution
Slide 04: How it works (3-step process)
Slide 05: Proof — past results / case study
Slide 06: Market opportunity
Slide 07: Our team / our edge
Slide 08: Pricing & packages
Slide 09: Timeline / what we'll do this month
Slide 10: Risk & mitigation
Slide 11: Social proof / testimonials
Slide 12: CTA — next step

For each slide: Title | 3 bullet points max | Suggested visual

Company-specific context:
- Turicks: Emphasize agentic AI systems, MERN expertise, local competitive pricing, 3-day delivery.
- Naggar: Emphasize farm-to-table authenticity, HP mountain terroir, slow living, small/intimate experience."""

    resp = call_deep_research(prompt)
    
    filename = f"pitch_deck_{company}_{pitch_type.replace(' ', '_')}_{date.today()}.md"
    filepath = STRATEGIC_DIR / company / filename
    filepath.write_text(f"# {pitch_type.title()} — {company.title()}\n\n{resp}")
    
    return resp


# ═══════════════════════════════════════════════════════════════════════════════
# WORKFLOW 5: Weekly Synergy Brief (Cross-company executive summary)
# ═══════════════════════════════════════════════════════════════════════════════

def generate_weekly_brief() -> str:
    """
    The "Chairman's Monday Morning Brief" — synthesises both companies into one
    executive summary. Posted to #The_Boardroom every Monday at 08:00.
    """
    # Pull top insights from both companies
    synergy = cross_company_search("performance revenue growth opportunities", n_results=5)
    turicks_ctx = "\n".join(synergy["turicks"])
    naggar_ctx  = "\n".join(synergy["naggar"])

    prompt = f"""You are the Chief of Staff writing a Monday executive brief for Pushkar Verma, founder of Turicks and Naggar Retreat.

Turicks context:
{turicks_ctx}

Naggar Retreat context:
{naggar_ctx}

Date: {datetime.now().strftime('%A, %B %d, %Y')}

Write a 200-word executive brief covering:
1. ✅ Wins last week (both companies)
2. 🎯 Top 3 priorities this week
3. ⚠️ One risk to monitor
4. 💡 One cross-company synergy opportunity
5. Today's single most important action

Tone: direct, no fluff. Talk to Pushkar as a peer, not a subordinate."""

    resp = call_deep_research(prompt)
    brief = f"*📋 Chairman's Weekly Brief — {datetime.now().strftime('%B %d')}*\n\n{resp}"
    
    # Save
    filepath = STRATEGIC_DIR / f"weekly_brief_{date.today()}.md"
    filepath.write_text(brief)
    
    return brief


# ═══════════════════════════════════════════════════════════════════════════════
# NOTEBOOK STRUCTURE (for manual NotebookLM setup)
# ═══════════════════════════════════════════════════════════════════════════════

NOTEBOOKLM_SETUP_GUIDE = """
# NotebookLM Notebook Structure for FounderOS

## 🏢 Turicks Notebook (notebook.google.com)
Sources to add:
  1. ~/Documents/Coding stuff/FounderOS/strategic_output/turicks/ → all market reports (add weekly)
  2. ~/Documents/Coding stuff/FounderOS/turicks_agency/context.py → paste as text source
  3. Past winning proposals (export from Upwork as PDF)
  4. turicks.com website (add URL source)
  5. Competitor agency websites (add 3 URLs)

Key queries to have ready:
  - "What are the top 3 services we should pitch to EU clients in Q2?"
  - "Create a comparison table vs [competitor]"
  - "Generate an Audio Overview of this week's bidding results"
  - "Write a 14-slide pitch for an AI automation retainer package"

## 🌿 Naggar Notebook (notebook.google.com)
Sources to add:
  1. ~/Documents/Coding stuff/FounderOS/strategic_output/naggar/ → all farm/market reports
  2. ~/Documents/Coding stuff/FounderOS/naggar_retreat/context.py → paste as text source
  3. Weather + yield logs (export from #Naggar_HQ weekly)
  4. Freshplaza.com (add URL — Dutch berry market)
  5. Airbnb competitor listings (screenshot + add as image source)

Key queries to have ready:
  - "What's the optimal pricing for peak season based on competitor data?"
  - "Generate an Audio Overview: 'Q3 Raspberry Harvest Strategy Briefing'"
  - "Create a guest experience comparison table vs Zostel Manali"
  - "Turn this week's farm log into a Substack draft"
"""

def print_setup_guide():
    print(NOTEBOOKLM_SETUP_GUIDE)

if __name__ == "__main__":
    print_setup_guide()
    # Quick test: generate weekly brief
    brief = generate_weekly_brief()
    print(brief)
