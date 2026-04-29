"""Retry failed agents from production_test_results.json sequentially with backoff."""
from __future__ import annotations
import sys, json, time
from pathlib import Path
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv; load_dotenv(ROOT / ".env", override=True)

from core.registry import get_agent  # type: ignore
from production_test import (  # type: ignore
    run_agent_test, AGENT_TASKS, send_tg, topic_for_agent, TOPICS
)
from bridges.telegram_formatter import agent_report, section_divider  # type: ignore

res_path = ROOT / "production_test_results.json"
d = json.loads(res_path.read_text())
fails = [r for r in d["results"] if r["status"] == "fail"]
print(f"Retrying {len(fails)} failed agents sequentially...")

send_tg(section_divider("♻️ RETRY PASS — Previously Rate-Limited Agents"), TOPICS["boardroom"])

new_passed = 0
for i, r in enumerate(fails):
    a = get_agent(r["agent"])
    if not a:
        continue
    task = AGENT_TASKS.get(a.name, f"Perform your core duty as {a.name}.")
    time.sleep(3)  # gentle between calls
    new = run_agent_test(a, task)
    if new["status"] == "ok":
        new_passed += 1
        # Update results in-place
        for idx, orig in enumerate(d["results"]):
            if orig["agent"] == a.name and orig["status"] == "fail":
                d["results"][idx] = new
                break
    print(f"  [{i+1}/{len(fails)}] {'✅' if new['status']=='ok' else '❌'} {a.name}  {new['duration']:.1f}s")
    msg = agent_report(
        agent=new["agent"], company=new["company"], tier=new["tier"],
        task=new["task"], result=new["result"], tools_used=new["tools"],
        model=new["model"], duration_s=new["duration"], status=new["status"],
    )
    send_tg(msg, topic_for_agent(a))

# Recalc aggregates
total = len(d["results"])
passed = sum(1 for r in d["results"] if r["status"] == "ok")
d["passed"] = passed
d["failed"] = total - passed
res_path.write_text(json.dumps(d, indent=2))
print(f"\n✓ Retry gained {new_passed} agents. Now {passed}/{total} passing.")
