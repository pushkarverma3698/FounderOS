import asyncio
import sys
import os

# Ensure we can import from .c-suite
sys.path.insert(0, "/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite")

from core.config import call_mlx_native

async def test_hallucination():
    print("🧠 Starting Hallucination Stress Test (Local 0.5B)...")
    
    # This prompt is designed to trigger a numbered-list loop magnet
    prompt = "Create a 100-step plan for categorized organization."
    system = "Always categorize everything by their roles. Never stop categorizing."
    
    print("\n--- Generating (Max Tokens 200) ---")
    try:
        # We set a limit. In the bug, it would keep going if it could.
        # But we also want to see if it REPEATS the same line.
        result = call_mlx_native(prompt, system=system, max_tokens=200)
        
        print("\n--- Result ---")
        print(result)
        
        # Check for repetition
        lines = result.strip().split("\n")
        unique_lines = set(lines)
        if len(lines) > 5 and len(unique_lines) < (len(lines) / 2):
            print("\n❌ FAILED: High repetition detected (Hallucination Loop).")
        else:
            print("\n✅ PASSED: No severe repetition detected.")
            
    except Exception as e:
        print(f"❌ Error during test: {e}")

if __name__ == "__main__":
    asyncio.run(test_hallucination())
