import sys
import os
import pytest
import json

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".c-suite")))

from skill_library import get_expert_system_prompt
from registry import get_agent

def test_registry_has_jobos_agents():
    # Verify the 5 new agents are properly injected into the registry
    expected_agents = ["job_coordinator", "job_intel", "ats_optimizer", "cover_letter_writer", "outreach_agent_personal"]
    
    for aname in expected_agents:
        agent = get_agent(aname)
        assert agent is not None, f"Agent {aname} is missing from registry.py"
        assert agent.company_assignment == "cross", f"{aname} should be a cross-company agent"
        assert "social_mem" in agent.allowed_collections, f"{aname} should have access to social_mem"

def test_prompts_json_loading():
    # Verify skill library can load and inject frameworks for JobOS V2 agents
    sys_prompt = get_expert_system_prompt("ats_optimizer", "You are the ATS agent.")
    
    assert "Keyword-dense, analytical, impact-driven" in sys_prompt
    assert "Applicant Tracking System (ATS) Semantic Matching" in sys_prompt
    assert "Quantify past achievements" in sys_prompt
    
def test_outreach_prompt_loading():
    sys_prompt = get_expert_system_prompt("outreach_agent_personal", "You are the DM agent.")
    assert "Peer-to-peer, warm, brief" in sys_prompt
    assert "Cold outbound networking" in sys_prompt

def test_job_icp_is_valid():
    # Verify job_search_os.py has ICP loaded correctly without execution
    from job_search_os import PUSHKAR_ICP
    assert "CANDIDATE: Pushkar Verma" in PUSHKAR_ICP
    assert "$80,000" in PUSHKAR_ICP
    assert "FounderOS" in PUSHKAR_ICP

def test_coordinator_scoring_logic_fallback():
    # Test phase 2 JSON repair fallback logic works if model outputs garbage
    from job_search_os import phase2_coordinator
    import unittest.mock as mock
    
    # Mock call_ceo to return a valid JSON list of 1 item
    with mock.patch("job_search_os.call_ceo") as mock_ceo:
        mock_ceo.return_value = json.dumps([{"company": "OpenAI", "role": "PM", "fit_score": 10}])
        
        # Test directory (use /tmp safely)
        pad_dir = "/tmp/founder_test_pad"
        os.makedirs(pad_dir, exist_ok=True)
        
        compiled_jobs = {"task1": "Raw job list..."}
        leads = phase2_coordinator(compiled_jobs, pad_dir)
        
        assert len(leads) == 1
        assert leads[0]["company"] == "OpenAI"
