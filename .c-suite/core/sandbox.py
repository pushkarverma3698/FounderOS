"""
FounderOS — Sandboxing & Worktrees
=============================================================
Mirrors the safety constraints of Claude Code:

1. SafeSubprocess: Prevents 'rm -rf /', 'sudo', etc.
2. run_in_worktree: A context manager that forks the repo into a temp directory to perform destructive tests before copying them back.
"""

import subprocess
import os
import shutil
import tempfile
from contextlib import contextmanager

DENY_LIST = [
    "sudo ",
    "rm -rf /",
    "rm -rf ~",
    "mkfs",
    "dd if=",
    "chmod -R 777 /"
]

def safe_run(command_string: str, cwd: str = None) -> str:
    """Executes a bash command only if it passes the security check."""
    for banned in DENY_LIST:
        if banned in command_string:
            raise PermissionError(f"[SANDBOX] Blocked destructive payload containing: '{banned}'")
            
    result = subprocess.run(
        command_string, 
        shell=True, 
        cwd=cwd, 
        capture_output=True, 
        text=True
    )
    if result.returncode != 0:
        return f"Error ({result.returncode}):\n{result.stderr}"
    return result.stdout

@contextmanager
def run_in_worktree():
    """
    Simulates a git worktree isolation.
    Copies the current FounderOS directory into a /tmp/ folder, 
    yields the path for agent manipulation, and requires explicit
    manual merging afterwards to prevent fatal agent breakage.
    """
    src_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    temp_dir = tempfile.mkdtemp(prefix="founder_worktree_")
    
    # Simple copytree for isolation (mocking git worktree)
    ignore_patterns = shutil.ignore_patterns(".git", "chroma_data", "__pycache__")
    
    try:
        shutil.copytree(src_dir, os.path.join(temp_dir, "FounderOS"), ignore=ignore_patterns, dirs_exist_ok=True)
        worktree_path = os.path.join(temp_dir, "FounderOS")
        yield worktree_path
    finally:
        # We don't auto-merge. The agent must export a patch or diff that the Coordinator approves.
        shutil.rmtree(temp_dir)
