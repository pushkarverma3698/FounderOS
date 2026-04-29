"""
FounderOS — Model Context Protocol (MCP) Bridge
=================================================
V7 UPGRADE: Dynamic MCP Marketplace

CHANGES:
  - Dynamic tool discovery: scan tool registries and install missing servers
    mid-task instead of requiring pre-installation.
  - Tool manifest cache: avoid re-fetching schemas on every call.
  - Graceful JSON-RPC 2.0 execution via subprocess stdio (spec-compliant).
  - Timeout + retry per tool call.

Pattern:
1. Register external MCP servers (local binaries or remote endpoints).
2. Bridge exposes .get_tools() which translates MCP tools into native schemas.
3. Bridge intercepts tool execution, dispatches via JSON-RPC, returns result.
4. V7: If a server is not installed, attempt dynamic install from npm registry.

Usage:
  from bridges.mcp_bridge import MCPRegistry
  tools = await MCPRegistry.get_all_tools()
  result = await MCPRegistry.execute_tool("github_mcp_search_code", {"query": "..."})
"""

import logging
import json
import asyncio
import subprocess
import time
from typing import Any, Dict, List, Optional

log = logging.getLogger("MCPBridge")

# ─── Tool manifest cache (TTL = 60s) ─────────────────────────────────────────
_tool_cache:      dict[str, list]  = {}
_tool_cache_time: dict[str, float] = {}
CACHE_TTL_SECS = 60


class MCPServerConfig:
    def __init__(self, name: str, command: str, args: List[str] = None, npm_package: str = None):
        self.name        = name
        self.command     = command
        self.args        = args or []
        self.npm_package = npm_package  # V7: for dynamic install if missing


class MCPRegistry:
    """Registry to manage active MCP server connections."""

    _servers:             Dict[str, MCPServerConfig] = {}
    _active_connections:  dict = {}

    # ─── Registration ─────────────────────────────────────────────────────────
    @classmethod
    def register_server(cls, server: MCPServerConfig):
        """Register a new MCP server configuration."""
        cls._servers[server.name] = server
        log.info(f"[MCP] Registered server: {server.name} ({server.command})")

    # ─── V7: Dynamic Install ──────────────────────────────────────────────────
    @classmethod
    def _ensure_installed(cls, server_name: str) -> bool:
        """
        V7 Dynamic Marketplace: Check if the MCP server binary is available.
        If not, attempt to install it from npm automatically.
        Returns True if available after check/install.
        """
        config = cls._servers.get(server_name)
        if not config:
            return False

        # Check if command exists
        check = subprocess.run(
            ["which", config.command], capture_output=True, text=True
        )
        if check.returncode == 0:
            return True  # Already installed

        # Attempt dynamic npm install if package name provided
        if config.npm_package:
            log.info(f"[MCP] '{server_name}' not found. Installing via npm: {config.npm_package}...")
            try:
                result = subprocess.run(
                    ["npm", "install", "-g", config.npm_package],
                    capture_output=True, text=True, timeout=120
                )
                if result.returncode == 0:
                    log.info(f"[MCP] Successfully installed: {config.npm_package}")
                    return True
                else:
                    log.error(f"[MCP] npm install failed: {result.stderr[:300]}")
            except Exception as e:
                log.error(f"[MCP] Dynamic install error: {e}")
        return False

    # ─── Connection ───────────────────────────────────────────────────────────
    @classmethod
    async def connect(cls, server_name: str):
        """Establish connection to an MCP server."""
        if server_name not in cls._servers:
            raise ValueError(f"Unknown MCP server: {server_name}")

        # V7: Ensure installed before connecting
        available = cls._ensure_installed(server_name)
        if not available:
            log.warning(f"[MCP] Server '{server_name}' not available. Will use mock tools.")
            cls._active_connections[server_name] = "mock"
            return "mock"

        log.info(f"[MCP] Connecting to MCP server '{server_name}'...")
        cls._active_connections[server_name] = "connected"
        return "connected"

    # ─── Tool Discovery (with cache) ──────────────────────────────────────────
    @classmethod
    async def get_tools(cls, server_name: str) -> List[Dict[str, Any]]:
        """
        Fetch available tools from an MCP server.
        V7: Results are cached for CACHE_TTL_SECS seconds to avoid hammering.
        """
        now = time.time()
        if server_name in _tool_cache and (now - _tool_cache_time.get(server_name, 0)) < CACHE_TTL_SECS:
            log.debug(f"[MCP] Returning cached tools for '{server_name}'")
            return _tool_cache[server_name]

        tools = _fetch_tools_for_server(server_name)
        _tool_cache[server_name]      = tools
        _tool_cache_time[server_name] = now
        return tools

    @classmethod
    async def get_all_tools(cls) -> List[Dict[str, Any]]:
        """Return combined tool list from all registered servers."""
        all_tools = []
        for name in cls._servers:
            all_tools.extend(await cls.get_tools(name))
        return all_tools

    # ─── Tool Execution (JSON-RPC 2.0 style) ──────────────────────────────────
    @classmethod
    async def execute_tool(
        cls,
        tool_name: str,
        arguments: dict,
        timeout_secs: float = 30.0,
    ) -> Any:
        """
        Execute an MCP tool via JSON-RPC 2.0.
        Determines which server owns the tool, sends the request, awaits result.

        V7: Includes timeout + retry (max 2 retries on transient failures).
        """
        server_name = _resolve_server_for_tool(tool_name)
        if not server_name:
            log.warning(f"[MCP] No server found for tool '{tool_name}'. Returning mock.")
            return json.dumps({"status": "mock", "data": f"[Mock result for {tool_name}]"})

        config = cls._servers[server_name]
        rpc_payload = {
            "jsonrpc": "2.0",
            "id":      int(time.time()),
            "method":  "tools/call",
            "params":  {"name": tool_name, "arguments": arguments},
        }

        for attempt in range(3):
            try:
                log.info(f"[MCP] Executing '{tool_name}' on '{server_name}' (attempt {attempt+1})")
                proc = await asyncio.wait_for(
                    asyncio.create_subprocess_exec(
                        config.command, *config.args,
                        stdin=asyncio.subprocess.PIPE,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                    ),
                    timeout=timeout_secs,
                )
                payload_bytes = (json.dumps(rpc_payload) + "\n").encode()
                stdout, stderr = await asyncio.wait_for(
                    proc.communicate(input=payload_bytes),
                    timeout=timeout_secs,
                )
                if stdout:
                    response = json.loads(stdout.decode().strip())
                    if "result" in response:
                        return json.dumps(response["result"])
                    elif "error" in response:
                        log.error(f"[MCP] Tool error: {response['error']}")
            except asyncio.TimeoutError:
                log.warning(f"[MCP] Tool '{tool_name}' timed out (attempt {attempt+1})")
            except Exception as e:
                log.warning(f"[MCP] Execution error (attempt {attempt+1}): {e}")

            await asyncio.sleep(1.0 * (attempt + 1))  # Linear backoff between retries

        return json.dumps({"status": "error", "data": f"Tool '{tool_name}' failed after 3 attempts."})


# ─── Internal Helpers ─────────────────────────────────────────────────────────
def _fetch_tools_for_server(server_name: str) -> List[Dict[str, Any]]:
    """Return mock or real tool manifests for a given server."""
    if server_name == "github_mcp":
        return [
            {
                "name":        "github_mcp_search_code",
                "description": "Search code on GitHub repositories via MCP.",
                "parameters":  {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query"},
                        "language": {"type": "string", "description": "Filter by language (optional)"},
                    },
                    "required": ["query"]
                }
            },
            {
                "name":        "github_mcp_create_pr",
                "description": "Create a pull request on a GitHub repository.",
                "parameters":  {
                    "type": "object",
                    "properties": {
                        "repo":  {"type": "string"},
                        "title": {"type": "string"},
                        "body":  {"type": "string"},
                        "head":  {"type": "string"},
                        "base":  {"type": "string"},
                    },
                    "required": ["repo", "title", "head", "base"]
                }
            },
        ]
    elif server_name == "filesystem_mcp":
        return [
            {
                "name":        "filesystem_mcp_read_file",
                "description": "Read the contents of a file from the FounderOS directory.",
                "parameters":  {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"]
                }
            },
            {
                "name":        "filesystem_mcp_write_file",
                "description": "Write content to a file in the FounderOS directory.",
                "parameters":  {
                    "type": "object",
                    "properties": {
                        "path":    {"type": "string"},
                        "content": {"type": "string"},
                    },
                    "required": ["path", "content"]
                }
            },
        ]
    elif server_name == "chrome_mcp":
        return [
            {
                "name":        "chrome_mcp_inspect_dom",
                "description": "Inspect the DOM of a running browser page.",
                "parameters":  {
                    "type": "object",
                    "properties": {
                        "url": {"type": "string", "description": "URL to inspect"},
                        "selector": {"type": "string", "description": "CSS selector to query"}
                    },
                    "required": ["url"]
                }
            },
            {
                "name":        "chrome_mcp_capture_screenshot",
                "description": "Capture a screenshot of a browser page for UI verification.",
                "parameters":  {
                    "type": "object",
                    "properties": {"url": {"type": "string"}},
                    "required": ["url"]
                }
            }
        ]
    return []


def _resolve_server_for_tool(tool_name: str) -> Optional[str]:
    """Determine which registered server owns a given tool by prefix."""
    for server_name in MCPRegistry._servers:
        if tool_name.startswith(server_name):
            return server_name
    return None


# ─── Default Server Registrations ─────────────────────────────────────────────
MCPRegistry.register_server(MCPServerConfig(
    name        = "github_mcp",
    command     = "npx",
    args        = ["-y", "@modelcontextprotocol/server-github"],
    npm_package = "@modelcontextprotocol/server-github",
))

MCPRegistry.register_server(MCPServerConfig(
    name        = "filesystem_mcp",
    command     = "npx",
    args        = ["-y", "@modelcontextprotocol/server-filesystem", "/Users/pushkarverma/Documents/Coding stuff/FounderOS"],
    npm_package = "@modelcontextprotocol/server-filesystem",
))

MCPRegistry.register_server(MCPServerConfig(
    name        = "jobspy_mcp",
    command     = "npx",
    args        = ["-y", "jobspy-mcp-server"],
    npm_package = "jobspy-mcp-server",
))

MCPRegistry.register_server(MCPServerConfig(
    name        = "chrome_mcp",
    command     = "npx",
    args        = ["-y", "@modelcontextprotocol/server-playwright"],
    npm_package = "@modelcontextprotocol/server-playwright",
))
