"""
FounderOS — JobOS V3: Interview Swarm
======================================
Deep-dive research for companies where Pushkar has scored an interview.
Generates an elite prep packet and stores context in career_mem.
"""

import os
import logging
from core.config import call_deep_research, call_md
from core.parallel_dispatch import dispatch_parallel_sync, WorkerTask
from memory.memory import career_mem, store

log = logging.getLogger("InterviewSwarm")

def run_interview_prep(company: str, role: str):
    """
    Kicks off the interview prep swarm.
    """
    log.info(f"🔥 Starting Interview Swarm for {company} ({role})")
    
    tasks = [
        WorkerTask(
            "tech_intel", "DEEP",
            f"Identify the full technical stack of {company}. Look for specific mention of "
            f"Python, LangGraph, agentic frameworks, or LLM infrastructure in their engineering blogs or job posts."
        ),
        WorkerTask(
            "financial_intel", "DEEP",
            f"Find recent financial news for {company} (last 6 months). Focus on funding rounds, "
            f"leadership changes, or major pivots. Look at Crunchbase/TechCrunch."
        ),
        WorkerTask(
            "personnel_intel", "DEEP",
            f"Research the engineering leadership (CTO, VP Eng) and AI team heads at {company}. "
            f"Identify their backgrounds and potential technical biases."
        )
    ]
    
    results = dispatch_parallel_sync(tasks, timeout_secs=180)
    intel_map = {r.task_id: r.result for r in results}
    
    # Generate the Prep Packet
    prep_prompt = f"""You are a Strategic Interview Coach for Pushkar Verma.
    
    COMPANY: {company}
    ROLE: {role}
    
    RESEARCH GATHERED:
    - Tech: {intel_map.get('tech_intel', 'Not found')}
    - Financials: {intel_map.get('financial_intel', 'Not found')}
    - Personnel: {intel_map.get('personnel_intel', 'Not found')}
    
    TASK:
    Generate a concise, tactical 1-page INTERVIEW PREP PACKET in Markdown.
    Include:
    1. 'The Hook': A specific detail about their tech or news Pushkar can mention to impress them.
    2. 'Probable Questions': 3 high-level technical/product questions they will likely ask.
    3. 'Magic Questions': 2 questions Pushkar should ask THEM to demonstrate dominance in AI.
    4. 'Personnel Red Flags/Green Flags': Quick notes on the hiring team.
    """
    
    packet = call_md(prep_prompt)
    
    # Persistence
    output_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".scratchpad", "interviews"))
    os.makedirs(output_dir, exist_ok=True)
    packet_path = os.path.join(output_dir, f"{company.replace(' ', '_')}_prep.md")
    
    with open(packet_path, "w") as f:
        f.write(packet)
        
    store(career_mem, f"interview_{company}", f"Prep for {role} at {company}: {packet}", {"type": "interview_prep", "company": company})
    
    log.info(f"✅ Interview Prep Packet delivered to: {packet_path}")
    return packet_path

if __name__ == "__main__":
    # Test
    run_interview_prep("OpenAI", "Product Manager (Agents)")
