"""
FounderOS — JobOS V4: HR Discovery Agent
=========================================
Finds the exact HR/Talent Acquisition personnel at target companies.
Generates personalized outreach hooks based on their recent activity.
"""

import os
import logging
import json
from core.config import call_deep_research, call_md
from core.parallel_dispatch import dispatch_parallel_sync, WorkerTask

log = logging.getLogger("HRScout")

def find_hr_contacts(company: str):
    """
    Uses deep research to find HR/TA names and LinkedIn URLs.
    """
    log.info(f"🔍 Searching for HR contacts at {company}...")
    
    search_query = (
        f"Find the names and LinkedIn URLs of the Talent Acquisition team or HR Managers at {company}. "
        f"Also find one recent post or professional interest for the top contact to use as an outreach hook. "
        f"Return as a JSON list of objects: name, title, profile_url, hook_context."
    )
    
    raw_results = call_deep_research(search_query)
    
    # Use MD agent to structure the raw research results
    structure_prompt = f"""Structure the following research about HR contacts at {company} into a valid JSON list of objects.
    
    RESEARCH:
    {raw_results}
    
    OBJECT FORMAT:
    {{
        "name": "Full Name",
        "title": "Exact Title",
        "profile_url": "LinkedIn URL",
        "hook_context": "One sentence summary of a recent post or interest"
    }}
    """
    
    structured_raw = call_md(structure_prompt)
    
    try:
        from json_repair import repair_json
        contacts = repair_json(structured_raw, return_objects=True) or []
    except Exception:
        contacts = []
        
    log.info(f"✅ Found {len(contacts)} HR contacts for {company}.")
    return contacts

def generate_outreach_options(company: str, role: str, contact: dict):
    """
    Generates tailored LinkedIn and Email drafts for a specific HR contact.
    """
    prompt = f"""You are a Strategic Outreach Expert.
    
    COMPANY: {company}
    ROLE: {role}
    CONTACT: {contact['name']} ({contact['title']})
    CONTEXT FOR HOOK: {contact['hook_context']}
    
    TASK:
    Draft 2 options for Pushkar:
    1. A 'Soft Hook' LinkedIn connection note (max 300 chars).
    2. A 'Direct Pitch' Email (150 words) that references the hook context.
    
    TONE: Peer-to-peer, professional, not needy.
    """
    
    return call_md(prompt)

if __name__ == "__main__":
    # Test
    res = find_hr_contacts("Neuralink")
    print(json.dumps(res, indent=2))
