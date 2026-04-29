"""
FounderOS — Swarm Dashboard (TUI)
=============================================================
A real-time terminal monitor mimicking `ink/react` lazy-loading dashboards.
Watch background parallel tasks execute in FounderOS/.scratchpad/
"""

import time
import os
import sys
sys.path.insert(0, str(os.path.dirname(__file__)))

from rich.live import Live
from rich.table import Table

def generate_dashboard() -> Table:
    scratch_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".scratchpad"))
    table = Table(title="FounderOS — Active Swarms", expand=True)
    table.add_column("Agent / Task", style="cyan")
    table.add_column("Status", style="magenta")
    table.add_column("Last Update", justify="right", style="green")
    
    if os.path.exists(scratch_dir):
        for item in os.listdir(scratch_dir):
            path = os.path.join(scratch_dir, item)
            mtime = os.path.getmtime(path)
            age = time.time() - mtime
            status = "Processing Active" if age < 60 else "Idle / Complete"
            table.add_row(item, status, f"{age:.1f}s ago")
    else:
        table.add_row("No swarms active", "-", "-")
        
    return table

def run_dashboard():
    with Live(generate_dashboard(), refresh_per_second=2) as live:
        try:
            while True:
                time.sleep(0.5)
                live.update(generate_dashboard())
        except KeyboardInterrupt:
            pass

if __name__ == "__main__":
    run_dashboard()
