import pytest
import asyncio
from unittest.mock import patch, MagicMock

import sys
import os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '.c-suite')))

from a2a_gateway import delegate_task, A2ARegistry, ExternalAgent, FOUNDEROS_AGENT_CARD
from mcp_bridge import MCPRegistry, MCPServerConfig

@pytest.fixture
def mock_a2a_registry():
    A2ARegistry._agents.clear()
    agent = ExternalAgent("ext-1", "Ext Agent", "http://test", ["write_post"])
    A2ARegistry.register(agent)
    yield
    A2ARegistry._agents.clear()

@pytest.mark.asyncio
@patch('a2a_gateway.httpx.AsyncClient.post')
async def test_a2a_delegate_task(mock_post, mock_a2a_registry):
    """Test A2A Gateway correctly delegates and parses task responses."""
    mock_resp = MagicMock()
    mock_resp.json.return_value = {"status": "success", "result": "Post drafted"}
    mock_resp.raise_for_status = MagicMock()
    mock_post.return_value = mock_resp

    result = await delegate_task("write_post", {"topic": "AI"}, timeout_secs=1)
    
    assert result == {"status": "success", "result": "Post drafted"}
    mock_post.assert_called_once()
    
    # Assert it builds the correct payload
    call_kwargs = mock_post.call_args[1]
    assert call_kwargs["json"]["payload"] == {"topic": "AI"}
    assert call_kwargs["json"]["capability"] == "write_post"

@pytest.mark.asyncio
@patch('mcp_bridge.subprocess.run')
async def test_mcp_dynamic_install_check(mock_run):
    """Test MCP Bridge correctly identifies if a package needs npm fallback limit."""
    # Mocking `which` command failure
    mock_run.return_value.returncode = 1
    
    config = MCPServerConfig("test_mcp", "test_cmd", npm_package="test-pkg")
    MCPRegistry.register_server(config)
    
    # ensure_installed should return False if npm install also fails or is mocked to fail
    assert MCPRegistry._ensure_installed("test_mcp") == False
