"""
Security Audit: FounderOS Tool Hooks
====================================
Tests the zero-trust enforcement layer in tool_hooks.py.
"""

import sys, os
sys.path.append("/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite")

from core.tool_hooks import pre_tool_hook, post_tool_hook, HookResult

def test_hard_denials():
    print("--- Testing Hard Denials (Pattern Blocking) ---")
    bad_commands = ["rm -rf /", "DROP TABLE users;", "sudo rm -rf ."]
    for cmd in bad_commands:
        result = pre_tool_hook("bash", cmd, agent_name="senior_dev")
        print(f"Command: {cmd} | Result: {result.behavior} | Reason: {result.reason}")
        assert result.behavior == "deny"

def test_tool_manifest():
    print("\n--- Testing Tool Manifest Enforcement (Zero-Trust) ---")
    # senior_dev is NOT authorized for playwright or browser tools in registry.py
    # senior_dev allowed: ["bash", "read_file", "write_file", "search_web", "github_mcp"]
    
    # Authorized
    result = pre_tool_hook("bash", "ls", agent_name="senior_dev")
    print(f"Tool: bash (Authorized) | Result: {result.behavior}")
    assert result.behavior == "allow" or result.behavior == "require_approval"
    
    # Unauthorized
    result = pre_tool_hook("playwright_browse", "https://google.com", agent_name="senior_dev")
    print(f"Tool: playwright (UNAUTHORIZED) | Result: {result.behavior} | Reason: {result.reason}")
    assert result.behavior == "deny"

def test_secret_scrubbing():
    print("\n--- Testing Secret Scrubbing (Post-Tool) ---")
    raw_output = "Done. Created API Key: sk-1234567890abcdefghijklmnopqrstuv"
    clean = post_tool_hook("bash", raw_output, agent_name="senior_dev")
    print(f"Raw: {raw_output}")
    print(f"Clean: {clean}")
    assert "[REDACTED" in clean

if __name__ == "__main__":
    try:
        test_hard_denials()
        test_tool_manifest()
        test_secret_scrubbing()
        print("\n✅ SECURITY AUDIT PASSED")
    except AssertionError as e:
        print(f"\n❌ SECURITY AUDIT FAILED: {e}")
    except Exception as e:
        print(f"\n❌ ERROR DURING AUDIT: {e}")
