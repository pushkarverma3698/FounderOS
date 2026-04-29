import asyncio
import sys
import os
import json

# Ensure we can import from .c-suite
sys.path.insert(0, "/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite")

from core.orchestrator import graph
from core.config import SQLITE_PATH

async def run_test():
    print("🚀 Starting Autonomous SEO Test for turicks.com...")
    
    # Thread ID for this specific test
    thread_config = {"configurable": {"thread_id": "test_turicks_seo_audit"}}
    
    # Message to send
    input_state = {
        "messages": ["Research turicks.com and have the SEO specialist perform a full audit."],
        "denial_count": 0,
        "denial_triggered": False,
        "research_approved": False,
        "synthesis_approved": False,
        "implementation_approved": False
    }

    # Node: CEO + Research
    print("--- Phase 0/1: CEO Routing & Research ---")
    state = graph.invoke(input_state, thread_config)
    print(f"Company: {state.get('company')}")
    print(f"Task: {state.get('task')}")
    print(f"Status: {state.get('result')}")

    # Auto-Approve Research
    print("\n--- Auto-Approving Research ---")
    graph.update_state(thread_config, {"research_approved": True})
    state = graph.invoke(None, thread_config)
    print(f"Status: {state.get('result')}")

    # Auto-Approve Synthesis
    print("\n--- Auto-Approving Synthesis (Implementation Spec) ---")
    graph.update_state(thread_config, {"synthesis_approved": True})
    state = graph.invoke(None, thread_config)
    print(f"Status: {state.get('result')}")
    
    # Check for specialist result
    print("\n--- Implementation Progress ---")
    if state.get("implementation_result"):
        print("✅ SEO Specialist Audit Result Captured")
        print(state["implementation_result"][:500] + "...")
    else:
        print("❌ Waiting for specialist worker...")
        # One more step for verification
        graph.update_state(thread_config, {"implementation_approved": True})
        state = graph.invoke(None, thread_config)
        print(f"Status: {state.get('result')}")

    print("\n🚀 Test Complete. Checking result in final state.")

if __name__ == "__main__":
    asyncio.run(run_test())
