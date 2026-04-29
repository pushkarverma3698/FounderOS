import pytest
from unittest.mock import patch, MagicMock

import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '.c-suite')))

from orchestrator import (
    ceo_node,
    research_node,
    gate_research,
    route_research,
    verification_node,
    route_verification,
    FounderState
)

@pytest.fixture
def base_state():
    return FounderState(
        messages=["Perform a competitor analysis on SpaceX."],
        company="unknown",
        task="Perform a competitor analysis on SpaceX.",
        research_results="",
        synthesis_result="",
        implementation_result="Mock implementation output.",
        verification_result="",
        result="",
        research_approved=False,
        synthesis_approved=False,
        implementation_approved=False,
        refined_once=False,
        gatekeeper_critique=""
    )

@patch('orchestrator.call_ceo')
def test_ceo_node(mock_ceo, base_state):
    """Test that the CEO node properly parses JSON routing instructions."""
    mock_ceo.return_value = '{"company": "turicks", "task": "analyze SpaceX"}'
    
    new_state = ceo_node(base_state)
    assert new_state["company"] == "turicks"
    assert new_state["task"] == "analyze SpaceX"
    assert new_state["refined_once"] == False

def test_gate_routing(base_state):
    """Test that conditional boundaries respect human approval flags."""
    assert route_research(base_state) == "finalize"  # Defaults to False
    base_state["research_approved"] = True
    assert route_research(base_state) == "synthesis_node"

@patch('orchestrator.call_md')
def test_verification_hard_gate_pass(mock_md, base_state):
    """Test Phase 4 Hard Gate correctly handles passes."""
    mock_md.return_value = "YES. This perfectly addresses the goal."
    
    new_state = verification_node(base_state)
    assert new_state["result"].startswith("✅ FINAL OUTPUT")
    assert new_state["refined_once"] == False
    assert route_verification(new_state) == "finalize"

@patch('orchestrator.call_md')
def test_verification_hard_gate_fail_once(mock_md, base_state):
    """Test Phase 4 Hard Gate properly intercepts the FIRST failure and routes back."""
    mock_md.return_value = "NO. You hallucinated the financial data."
    
    new_state = verification_node(base_state)
    assert new_state["result"].startswith("⚠️ HARD GATE ACTIVATED")
    assert new_state["refined_once"] == True
    assert "hallucinated" in new_state["gatekeeper_critique"]
    
    assert route_verification(new_state) == "implementation_node"
    assert new_state.get("implementation_approved", False) == False # forces re-routing

@patch('orchestrator.call_md')
def test_verification_hard_gate_fail_twice(mock_md, base_state):
    """Test Phase 4 Hard Gate forces finalization on SECOND failure to prevent infinite loops."""
    base_state["refined_once"] = True # simulate already having looped back once
    mock_md.return_value = "NO. The fix didn't work completely."
    
    new_state = verification_node(base_state)
    assert new_state["result"].startswith("⚠️ FINAL OUTPUT (Forced through after 1 refinement):")
    # Does not loop back again
    assert route_verification(new_state) == "finalize"
