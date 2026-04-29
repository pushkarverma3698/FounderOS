"""
Seed Pushkar's LinkedIn content strategy into social_mem ChromaDB.
Run once (or re-run to refresh strategy):
    python .c-suite/tools/seed_content_strategy.py
"""
import sys, os
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env", override=True)

import chromadb

STRATEGY = """
PUSHKAR VERMA — LINKEDIN CONTENT STRATEGY v1.0 (April 2026)

WHO AM I:
Solo founder running two businesses simultaneously:
- Turicks: AI/SaaS development agency (LangGraph, Next.js, MERN, AI automation)
- Naggar Retreat: Premium Himalayan farm + homestay at 1768m in Naggar, Manali HP
Currently building FounderOS V8 — a 39-agent autonomous AI OS that runs both companies.
Going to Amsterdam in June 2026 to meet Dutch startups and expand EU pipeline.

CONTENT PILLARS (rotate weekly):
1. BUILD_LOG — What I shipped this week. Architecture decisions, what broke, what worked.
   Show real code. Show real agent outputs. Specific and honest.
   Hook pattern: "I built X. Here's what surprised me."

2. FOUNDER_STORY — Running an AI agency from a mountain homestay in Manali.
   Real metrics. Real struggles. No false positives.
   Hook pattern: "7 months. No clients. Here's what changed this week."

3. AI_EDUCATION — How specific FounderOS agents work. LangGraph internals.
   Practical, reproducible tutorials. Code snippets that work.
   Hook pattern: "Here's how [specific agent] decides what tool to call next."

4. REVENUE — Transparent revenue updates. First Upwork contract. First Gumroad sale.
   Real numbers. What worked, what didn't.
   Hook pattern: "₹0 → ₹X. Here's the exact sequence."

5. AMSTERDAM (June 2026+) — Pitching Dutch startups. EU tech scene. Heineken network.
   Culture contrast. Outsider observations that insiders miss.
   Hook pattern: "Dutch founders do X differently. Here's what I'm learning."

VOICE RULES (non-negotiable):
- First person, conversational
- Never: "excited to share", "thrilled to announce", "humbled by", "game-changer"
- Lead with a specific number, a counterintuitive claim, or a question
- Short paragraphs: 1-3 lines max (mobile reading)
- End with something that invites a comment OR teases the next post
- Max 3 emojis total, only where they add signal not decoration
- 150-300 words (sweet spot for LinkedIn algorithm 2026)

POST FORMATS THAT WORK:
A) The Build Log: "I built [X]. Here's what I learned. [code/architecture]. Would you do it differently?"
B) The Honest Numbers: "7 months. No clients. Here's what I changed this week."
C) The Contrast: "Standard agencies give you a website. I give you a website + AI agent trained on it."
D) The Thread Starter: "I'm documenting everything about building a 39-agent AI OS. Week 1: [thread 🧵]"
E) The Demo: "This agent just did [real task] in [time]. Here's the exact prompt chain."

NEVER POST:
- Motivational quotes without original angle
- Reshared articles without 200+ words of original commentary
- Product launches without showing the actual product working
- Engagement bait ("like and comment if you agree")
- Anything that sounds like a press release

POSTING SCHEDULE:
- Tuesday 09:00 IST — BUILD_LOG (highest engagement window)
- Thursday 11:00 IST — AI_EDUCATION or agent demo
- Saturday 10:00 IST — FOUNDER_STORY or REVENUE update

AUDIENCE:
Primary: SaaS founders, AI/ML engineers, indie hackers
Secondary: VCs scouting builders, recruiters (backup plan), other solo founders
Desired outcome: inbound leads for Turicks agency + audience for future products

CURRENT METRICS BASELINE (April 2026):
- LinkedIn followers: building from scratch
- Target Week 4: +200 followers, 3 inbound leads
- Target Week 12: +2000 followers, $8K revenue
"""

def seed():
    chroma_path = str(Path(__file__).parent.parent / "memory" / "chroma_data")
    client = chromadb.PersistentClient(path=chroma_path)
    collection = client.get_or_create_collection("social_mem")

    # Check if already seeded
    existing = collection.get(ids=["content_strategy_v1"])
    if existing["ids"]:
        collection.update(
            ids=["content_strategy_v1"],
            documents=[STRATEGY],
            metadatas=[{"type": "strategy", "updated": "2026-04-28", "version": "1.0"}],
        )
        print("✅  Content strategy UPDATED in social_mem")
    else:
        collection.add(
            ids=["content_strategy_v1"],
            documents=[STRATEGY],
            metadatas=[{"type": "strategy", "updated": "2026-04-28", "version": "1.0"}],
        )
        print("✅  Content strategy SEEDED into social_mem")

    count = collection.count()
    print(f"   social_mem now has {count} documents")

if __name__ == "__main__":
    seed()
