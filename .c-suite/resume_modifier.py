"""
FounderOS — JobOS V3: Resume Modifier Agent
============================================
Tailors the master_resume.md to a specific Job Description (JD).
Outputs a temporary .md file and triggers the PDF engine.
"""

import os
import logging
from core.config import call_ceo, call_md

log = logging.getLogger("ResumeTailor")

MASTER_RESUME_PATH = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "master_resume.md"))

def tailor_resume(jd_text: str, output_path: str):
    """
    Main tailoring logic:
    1. Read Master Resume.
    2. Rank bullets by relevance to JD.
    3. Rewrite top bullets for keyword alignment.
    4. Guardrail against hallucination.
    """
    if not os.path.exists(MASTER_RESUME_PATH):
        log.error("Master resume missing!")
        return None

    with open(MASTER_RESUME_PATH, "r") as f:
        master_data = f.read()

    tailor_prompt = f"""You are an elite ATS Strategy Expert and Resume Writer.

MASTER RESUME DATA:
{master_data}

TARGET JOB DESCRIPTION:
{jd_text}

TASK:
Tailor the master resume to this specific job. 
1. Keep the high-level structure (Contact, Summary, Skills, Experience, Projects).
2. In 'Experience', select the 3-5 most relevant bullet points from the master data.
3. REWRITE those bullets slightly to use keywords from the JD (e.g., if JD mentions 'Agentic Workflow', ensure that term appears in a bullet if relevant to Pushkar's 27-agent system).
4. Ensure all metrics ($, %, dates) remain ACCURATE to the master data. DO NOT hallucinate new metrics.
5. Tone: Professional, data-driven, engineering-excellence.

OUTPUT:
Return ONLY the tailored resume in clean Markdown format. No conversational text."""

    log.info("🎯 Tailoring resume for JD...")
    tailored_md = call_ceo(tailor_prompt)
    
    with open(output_path, "w") as f:
        f.write(tailored_md)
    
    log.info(f"✅ Tailored resume saved to: {output_path}")
    return tailored_md

if __name__ == "__main__":
    # Test call
    sample_jd = "Looking for an AI Product Manager with experience in LangGraph and multi-agent systems."
    tailor_resume(sample_jd, "/tmp/tailored_test.md")
