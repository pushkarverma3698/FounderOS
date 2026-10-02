#!/usr/bin/env python3
import json
import sys
import html
import os

def main():
    if len(sys.argv) < 2:
        return
    log_file = sys.argv[1]
    if not os.path.exists(log_file) or os.path.getsize(log_file) == 0:
        return

    # Read last 64KB
    try:
        with open(log_file, "rb") as f:
            f.seek(max(0, os.path.getsize(log_file) - 65536))
            chunk = f.read().decode("utf-8", errors="ignore")
    except Exception:
        return

    steps = {}
    active_action = None
    is_json = False

    for line in chunk.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        if line.startswith("{") and line.endswith("}"):
            try:
                data = json.loads(line)
                is_json = True
                ev = data.get("event")
                if ev == "step_update":
                    su = data["step_update"]
                    idx = su.get("step_index", 0)
                    stype = su.get("step_type")
                    state = su.get("state")

                    if stype == "tool":
                        tname = su.get("tool_name", "tool")
                        tparams = su.get("tool_info", {}).get("parameters", {})
                        param = (
                            tparams.get("CommandLine") or 
                            tparams.get("TargetFile") or 
                            tparams.get("AbsolutePath") or 
                            tparams.get("path") or 
                            tparams.get("Query") or 
                            tparams.get("query") or 
                            tparams.get("Pattern") or 
                            ""
                        )
                        if len(param) > 35:
                            param = os.path.basename(param) if "/" in param else param[:32] + "..."
                        
                        icon = "⏳" if state == "ACTIVE" else "✅"
                        steps[idx] = f"{icon} <code>{html.escape(tname)}</code> {html.escape(param)}".strip()
                        if state == "ACTIVE":
                            active_action = steps[idx]
                        else:
                            active_action = None
                    elif stype == "agent_response":
                        if state == "ACTIVE":
                            active_action = "🤔 <i>Thinking...</i>"
                        elif state == "DONE":
                            active_action = None
                elif ev == "result":
                    res = data.get("result", {})
                    status = res.get("status", "COMPLETE")
                    active_action = f"🏁 <b>{status}</b>"
            except Exception:
                pass

    if is_json and steps:
        recent = list(steps.values())[-4:]
        if active_action and (not recent or recent[-1] != active_action):
            recent.append(active_action)
        if recent:
            print("<b>Live Progress:</b>\n" + "\n".join(recent))
            return

    # Fallback for plain text log format
    non_empty = [l.strip() for l in chunk.strip().split("\n") if l.strip()]
    if non_empty:
        tail = html.escape("\n".join(non_empty[-4:]))
        print(f"<b>Recent Output:</b>\n<code>{tail}</code>")

if __name__ == "__main__":
    main()
