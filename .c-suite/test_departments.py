"""Smoke-test the new departments architecture end-to-end."""
import sys
from pathlib import Path
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv; load_dotenv(ROOT / ".env", override=True)

from core.departments import run_founderos, build_department, DEPARTMENTS

print("=" * 70)
print("FounderOS — Departments architecture smoke test")
print("=" * 70)

# 1) Verify each department compiles + has workers
print("\n[1] Department membership:")
for name in DEPARTMENTS:
    g = build_department(name)
    nodes = list(g.get_graph().nodes.keys())
    workers = [n for n in nodes if n not in ("__start__", "__end__", "supervisor", "summarize")]
    print(f"  {name:9s} → {len(workers):2d} workers : {', '.join(workers[:6])}{' ...' if len(workers)>6 else ''}")

# 2) Run a Turicks task
print("\n[2] End-to-end run — Turicks task:")
task = "A potential client wants a LangGraph multi-agent system for legal-doc automation, $4K budget. Draft a 3-bullet response and a follow-up question."
out = run_founderos(task)
print(f"  Routed to: {out.get('handoff_chain')}")
print(f"  Workers called: {sum(len(d.get('workers_called',[])) for d in out.get('department_results',[]))}")
print("\n  --- FINAL ANSWER ---")
print((out.get("final_answer") or "")[:1500])

# 3) Run a cross-department task (should land in command)
print("\n[3] Cross-company task — should hit command (or hand off):")
task2 = "Quick scrum: 1 Turicks win, 1 Naggar concern, tomorrow's top 3 priorities."
out2 = run_founderos(task2)
print(f"  Routed to: {out2.get('handoff_chain')}")
print((out2.get("final_answer") or "")[:1000])

print("\n✓ Smoke test complete.")
