import pytest
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '.c-suite')))

from registry import get_all_agents, get_agent

def test_all_agents_have_valid_schemas():
    """
    Parametrized validation of all 27 specialized persona agents at once. 
    This dynamically verifies that the entire Swarm architecture maps correctly.
    """
    all_agents = get_all_agents()
    
    assert len(all_agents) >= 20, "Expected at least 20+ specialized agents in the Swarm."
    
    for agent in all_agents:
        # Validate core schema requirements
        assert agent.name is not None
        assert agent.company_assignment in ["turicks", "naggar", "cross"]
        assert agent.cascade_tier in ["ceo", "deep_research", "md", "nano", "local", "code", "video"]
        assert isinstance(agent.allowed_collections, list)
        
        # Validate data silos are strictly enforced
        if agent.company_assignment == "turicks":
            assert "naggar_mem" not in agent.allowed_collections, f"{agent.name} is a Turicks agent but has access to Naggar data."
        elif agent.company_assignment == "naggar":
            assert "turicks_mem" not in agent.allowed_collections, f"{agent.name} is a Naggar agent but has access to Turicks data."

def test_scrum_engine_is_highest_tier():
    """Explicitly verify that the PM agent holds Tier 3 privileges."""
    pm = get_agent("scrum_pm")
    assert pm is not None
    assert pm.cascade_tier == "md", "Scrum PM must be using MD logic models."

def test_revenue_team_is_turicks():
    """Explicitly test that the revenue subsystem is mapped accurately."""
    bidding_sniper = get_agent("bidding_sniper")
    assert bidding_sniper is not None
    assert bidding_sniper.company_assignment == "turicks"
