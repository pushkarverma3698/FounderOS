import sys
import os
import logging

# Add current directory to path
sys.path.insert(0, os.path.dirname(__file__))

from core.config import call_apple_intelligence
from core.tool_hooks import scrub_prompt

def test_scrubbing():
    print("--- Testing Privacy Scrubbing ---")
    dirty_prompt = "Analyze the code in /Users/pushkarverma/Documents/Coding stuff/FounderOS/core.py. My API key is sk-1234567890abcdef."
    clean_prompt = scrub_prompt(dirty_prompt)
    print(f"Original: {dirty_prompt}")
    print(f"Sanitized: {clean_prompt}")
    assert "[FOUNDEROS_ROOT]" in clean_prompt
    assert "[REDACTED_SK_KEY]" in clean_prompt
    print("✅ Scrubbing successful.")

def test_bridge_call():
    print("\n--- Testing Siri/PCC Bridge Call ---")
    print("Note: This will fail if the 'FounderOS_Intel' shortcut is not created yet.")
    try:
        # We'll try a simple prompt
        response = call_apple_intelligence("What is the capital of France?")
        print(f"Siri Response: {response}")
        print("✅ Bridge call successful.")
    except Exception as e:
        print(f"❌ Bridge call failed (expected if shortcut missing): {e}")

if __name__ == "__main__":
    test_scrubbing()
    test_bridge_call()
