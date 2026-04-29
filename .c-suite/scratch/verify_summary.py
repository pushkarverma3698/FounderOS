import asyncio
import sys
import os

# Ensure we can import from .c-suite
sys.path.insert(0, "/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite")

from core.orchestrator import graph
from core.config import SQLITE_PATH

async def run_summary_test():
    print("🚀 Running Full Autonomous Summary for turicks.com...")
    query = "Summarize turicks.com in 3 bullet points."
    
    thread_config = {"configurable": {"thread_id": "test_turicks_final_summary"}}
    
    input_state = {
        "messages": [query],
        "denial_count": 0,
        "denial_triggered": False,
        "research_approved": False,
        "synthesis_approved": False,
        "implementation_approved": False
    }

    # Node: CEO + Research
    print("\n--- Phase 0/1: CEO & Research ---")
    state = graph.invoke(input_state, thread_config)
    
    # Auto-Approve Research
    print("\n--- Phase 2: Synthesis ---")
    graph.update_state(thread_config, {"research_approved": True})
    state = graph.invoke(None, thread_config)
    
    # Check if we need to approve synthesis
    if "Synthesis complete" in state.get('result', ''):
        graph.update_state(thread_config, {"synthesis_approved": True})
        state = graph.invoke(None, thread_config)

    print("\n--- Final Result ---")
    print(state.get("implementation_result") or state.get("result"))

if __name__ == "__main__":
    asyncio.run(run_summary_test())
