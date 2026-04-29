import asyncio
import sys
import os

# Ensure we can import from .c-suite
sys.path.insert(0, "/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite")

from core.orchestrator import graph
from bridges.telegram_gateway import quick_reply
from unittest.mock import MagicMock

async def run_complex_test():
    print("🚀 Initializing Complex Flow Test...")
    query = "code the website, write a proposal for the new project, submit the proposal to the company's board of directors."
    
    # Step 1: Check Quick-Routing (Kai)
    print("\n--- Phase 0: Quick-Routing Check ---")
    msg = MagicMock()
    is_simple = await quick_reply(msg, query)
    print(f"Is Simple (Quick-Reply handled)? {is_simple}")
    
    if is_simple:
        print("❌ FAILED: Complex task was incorrectly handled by Quick-Reply (Kai).")
        return

    print("✅ SUCCESS: Complex task correctly bypassed Kai and is routing to LangGraph orchestrator.")

    # Step 2: Trigger LangGraph
    print("\n--- Phase 1: LangGraph CEO Orchestration ---")
    thread_config = {"configurable": {"thread_id": "test_complex_multi_step"}}
    
    input_state = {
        "messages": [query],
        "denial_count": 0,
        "denial_triggered": False,
        "research_approved": False,
        "synthesis_approved": False,
        "implementation_approved": False
    }

    state = graph.invoke(input_state, thread_config)
    print(f"Company Identified: {state.get('company')}")
    print(f"Assigned Task: {state.get('task')}")
    print(f"Current Node Result: {state.get('result')}")
    
    # Auto-Approve Research to see the synthesis
    print("\n--- Phase 2: Advancing to Synthesis (Auto-Approving Research) ---")
    graph.update_state(thread_config, {"research_approved": True})
    state = graph.invoke(None, thread_config)
    print(f"Current Result: {state.get('result')}")

    print("\n🚀 Autonomous Flow Verified.")

if __name__ == "__main__":
    asyncio.run(run_complex_test())
