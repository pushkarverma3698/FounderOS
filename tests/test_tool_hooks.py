import pytest
import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '.c-suite')))

from tool_hooks import pre_tool_hook, post_tool_hook

def test_mask_secrets():
    """Verify that credentials and PII are scrubbed automatically."""
    raw_output = "Connected to remote DB. The API key is sk-ant-api03-abcdef123. Ensure you don't share it."
    scrubbed = post_tool_hook("bash", raw_output, agent_name="test_agent")
    
    assert "sk-ant" not in scrubbed
    assert "[REDACTED_SK_KEY]" in scrubbed
    
    # Check Google AI pattern
    google_output = "Uploading to AI using AIzaSyA1B2C3D4E5F6G7H8I9J0"
    scrubbed2 = post_tool_hook("bash", google_output, agent_name="test_agent")
    assert "AIzaSy" not in scrubbed2

def test_safe_execute_blocks_rm_rf():
    """Verify hardware-level block preventing destructive shell commands."""
    res = pre_tool_hook("bash", "rm -rf /FounderOS/.c-suite/", agent_name="test_agent")
    assert res.behavior == "deny"

def test_safe_execute_blocks_db_pollution():
    """Verify agents cannot force write commands to foreign databases."""
    res = pre_tool_hook("bash", "DROP TABLE users;", agent_name="test_agent")
    assert res.behavior == "deny"

@pytest.mark.asyncio
async def test_safe_execute_allows_safe_commands():
    """Verify normal read commands flow through cleanly."""
    res = pre_tool_hook("bash", "echo 'hello world'", agent_name="test_agent")
    assert res.behavior == "allow"
