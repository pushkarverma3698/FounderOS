"""Verify worker nodes ACTUALLY call tools (not just describe them)."""
import sys
from pathlib import Path
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv; load_dotenv(ROOT / ".env", override=True)

from core.registry import get_agent
from core.departments.worker import make_worker
from core.departments.tools import execute_tool, tools_for_agent

print("=" * 70)
print("TOOL CALLING VERIFICATION")
print("=" * 70)

# 1) Sanity: tools execute directly
print("\n[1] Direct tool execution sanity:")
print("  bash:", execute_tool("bash", "echo hello-from-bash", "ops_agent")[:100])
print("  search_web:", execute_tool("search_web", "LangGraph agentic AI 2026", "lead_intel")[:120].replace("\n"," | "))
print("  chromadb_write:", execute_tool("chromadb_write", "turicks_mem::tool-test entry from verification run", "kb_agent"))
print("  chromadb_read:",  execute_tool("chromadb_read",  "turicks_mem::tool-test entry", "kb_agent")[:150])

# 2) End-to-end ReAct loop on an agent designed to use tools
print("\n[2] ReAct loop — ops_agent (should call bash)")
a = get_agent("ops_agent")
print(f"  Granted tools: {tools_for_agent(a.name)}")
worker = make_worker(a)
state = {"task": "Use the bash tool to count how many .py files are under .c-suite/core. Report the number."}
out = worker(state)
w = out["worker_outputs"][0]
print(f"  Steps taken: {w.get('steps')}, tools_used: {w.get('tools_used')}, status: {w['status']}")
print(f"  Final answer:\n  {w['result'][:400]}")

# 3) ReAct on lead_intel (should call search_web)
print("\n[3] ReAct loop — lead_intel (should call search_web)")
a2 = get_agent("lead_intel")
print(f"  Granted tools: {tools_for_agent(a2.name)}")
worker2 = make_worker(a2)
state2 = {"task": "Use search_web to find one real recent (2025/2026) post about AI agency pricing for SMEs. Report a 2-line summary citing the source."}
out2 = worker2(state2)
w2 = out2["worker_outputs"][0]
print(f"  Steps: {w2.get('steps')}, tools_used: {w2.get('tools_used')}, status: {w2['status']}")
print(f"  Answer:\n  {w2['result'][:400]}")

# 4) Silo-DENY check — kb_agent (turicks-only) tries to read naggar_mem
print("\n[4] Silo enforcement — kb_agent reading naggar_mem (must DENY)")
print("  ", execute_tool("chromadb_read", "naggar_mem::raspberry yield", "kb_agent")[:200])

print("\n✓ Tool-calling verification complete.")
