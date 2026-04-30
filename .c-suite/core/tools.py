"""
FounderOS — Agent Execution Tools
==================================
Real superpowers for agents: write Python and run it. Run shell. Pass through
the existing tool_hooks safety layer (rm -rf /, secret scrubbing, etc.).

Functions:
    execute_python(script, agent_name="", timeout=60) -> dict
    execute_bash(cmd, agent_name="", timeout=30) -> dict

Returns dict with: stdout, stderr, exit_code, success, script_path (if py).
"""
from __future__ import annotations
import hashlib, os, subprocess, tempfile, time, logging
from pathlib import Path

from core.tool_hooks import pre_tool_hook, post_tool_hook

log = logging.getLogger("AgentTools")

PY_BIN = "/Users/pushkarverma/mlx_env/bin/python"
SCRIPT_DIR = Path("/tmp/founderos_agent_scripts")
SCRIPT_DIR.mkdir(parents=True, exist_ok=True)

FOUNDEROS_ROOT = "/Users/pushkarverma/Documents/Coding stuff/FounderOS"


def execute_python(script: str, agent_name: str = "agent", timeout: int = 60) -> dict:
    """
    Write a Python script to /tmp and run it inside FounderOS's mlx_env.
    The script gets PYTHONPATH=.c-suite, so `from core.config import call_md`
    and `import chromadb` and `from memory.memory import recall` all just work.
    """
    if not script or not script.strip():
        return {"success": False, "stdout": "", "stderr": "Empty script", "exit_code": 1}

    # Hash the script so identical re-runs share a path (debuggable)
    h = hashlib.sha1(script.encode()).hexdigest()[:10]
    script_path = SCRIPT_DIR / f"{agent_name}_{h}.py"
    script_path.write_text(script)

    cmd_str = f"{PY_BIN} {script_path}"
    hook = pre_tool_hook("bash", cmd_str, agent_name=agent_name)
    if hook.behavior == "deny":
        log.warning(f"[execute_python] DENY ({agent_name}): {hook.reason}")
        return {"success": False, "stdout": "", "stderr": f"Hook denied: {hook.reason}",
                "exit_code": -1, "script_path": str(script_path)}

    env = os.environ.copy()
    env["PYTHONPATH"] = f"{FOUNDEROS_ROOT}/.c-suite:{env.get('PYTHONPATH', '')}"

    started = time.time()
    try:
        proc = subprocess.run(
            [PY_BIN, str(script_path)],
            capture_output=True, text=True, timeout=timeout,
            env=env, cwd=FOUNDEROS_ROOT,
        )
        out = post_tool_hook("bash", proc.stdout or "", agent_name=agent_name)
        err = post_tool_hook("bash", proc.stderr or "", agent_name=agent_name)
        return {
            "success": proc.returncode == 0,
            "stdout": out[:8000],
            "stderr": err[:4000],
            "exit_code": proc.returncode,
            "script_path": str(script_path),
            "elapsed_sec": round(time.time() - started, 2),
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "stdout": "", "stderr": f"Timeout after {timeout}s",
                "exit_code": -2, "script_path": str(script_path)}
    except Exception as e:
        return {"success": False, "stdout": "", "stderr": f"{type(e).__name__}: {e}",
                "exit_code": -3, "script_path": str(script_path)}


def execute_bash(cmd: str, agent_name: str = "agent", timeout: int = 30) -> dict:
    """Run a single bash command through the safety hook."""
    hook = pre_tool_hook("bash", cmd, agent_name=agent_name)
    if hook.behavior == "deny":
        return {"success": False, "stdout": "", "stderr": f"Hook denied: {hook.reason}",
                "exit_code": -1}
    real_cmd = hook.modified_input if hook.behavior == "modify" else cmd
    try:
        proc = subprocess.run(
            real_cmd, shell=True, capture_output=True, text=True,
            timeout=timeout, cwd=FOUNDEROS_ROOT,
        )
        return {
            "success": proc.returncode == 0,
            "stdout": post_tool_hook("bash", proc.stdout or "", agent_name=agent_name)[:8000],
            "stderr": post_tool_hook("bash", proc.stderr or "", agent_name=agent_name)[:4000],
            "exit_code": proc.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "stdout": "", "stderr": f"Timeout after {timeout}s", "exit_code": -2}
    except Exception as e:
        return {"success": False, "stdout": "", "stderr": f"{type(e).__name__}: {e}", "exit_code": -3}


_SCRIPT_PREAMBLE = """\
import sys, os
sys.path.insert(0, '/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite')
from dotenv import load_dotenv
load_dotenv('/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite/.env', override=True)
from core.agent_toolkit import (
    web_search, fetch_page,
    linkedin_get_my_posts, linkedin_get_profile, linkedin_post,
    store_memory, recall_memory, list_all_collections,
)
import chromadb, httpx
CHROMA_PATH = '/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite/memory/chroma_data'
"""

SYSTEM_TEMPLATE = """\
You are a Python automation engineer for FounderOS. Write a COMPLETE, SELF-CONTAINED Python script.

COPY THIS EXACT HEADER at the start of your script (do not modify it):
```
import sys, os
sys.path.insert(0, '/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite')
from dotenv import load_dotenv
load_dotenv('/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite/.env', override=True)
from core.agent_toolkit import (
    web_search, fetch_page, linkedin_get_my_posts, linkedin_get_profile,
    linkedin_post, store_memory, recall_memory, list_all_collections,
)
import chromadb, httpx
CHROMA_PATH = '/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite/memory/chroma_data'
```

AVAILABLE FUNCTIONS (from core.agent_toolkit):
- web_search(query, n=5)          → list[{title, url, snippet}]
- fetch_page(url)                  → str (clean page text)
- linkedin_get_my_posts(count=10)  → list[{text, source, likes}]  (reads social_mem, API read unavailable)
- linkedin_get_profile()           → dict (from memory)
- linkedin_post(text)              → {success, post_id, url}  (POSTS to LinkedIn — requires confirmation)
- store_memory(col, doc_id, text)  → bool
- recall_memory(col, query, n=5)   → list[str]
- list_all_collections()           → list[{name, count}]

RULES:
1. Start with the exact header above, then write your task logic.
2. NEVER use selenium, playwright, requests, pandas, torch, openai.
3. print() every result so output appears in stdout.
4. LinkedIn API read is unavailable — use linkedin_get_my_posts() which reads memory.
5. Output ONLY Python code. No markdown fences. No prose before or after.

EXAMPLE:
import sys, os
sys.path.insert(0, '/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite')
from dotenv import load_dotenv
load_dotenv('/Users/pushkarverma/Documents/Coding stuff/FounderOS/.c-suite/.env', override=True)
from core.agent_toolkit import web_search
results = web_search('AI agents LangGraph', n=3)
for r in results:
    print(r['title'], '|', r['snippet'][:100])
"""


def agent_write_and_run(agent_name: str, task: str, llm_caller, max_retries: int = 1) -> dict:
    """
    Self-correcting loop:
      1. Ask LLM to write a Python script.
      2. Execute it. If it fails, feed stderr back to LLM and retry up to max_retries times.
    `llm_caller` is a function (prompt, system) -> str (e.g. call_md from config).
    """
    history = []
    last_result = None
    for attempt in range(max_retries + 1):
        if attempt == 0:
            user_prompt = task
        else:
            user_prompt = (
                f"Your previous script failed. Fix it.\n\n"
                f"TASK: {task}\n\n"
                f"PREVIOUS SCRIPT:\n{history[-1]['code']}\n\n"
                f"ERROR (stderr):\n{history[-1]['stderr'][:1500]}\n\n"
                f"Output the corrected complete script — no fences, no prose."
            )
        raw = llm_caller(user_prompt, system=SYSTEM_TEMPLATE) or ""
        code = _extract_python_code(raw)
        # If the model forgot the preamble, inject it
        if "from core.agent_toolkit" not in code and "sys.path.insert" not in code:
            code = _SCRIPT_PREAMBLE + "\n" + code
        result = execute_python(code, agent_name=agent_name, timeout=45)
        result["generated_code"] = code
        result["attempt"] = attempt + 1
        history.append({"code": code, "stderr": result.get("stderr", "")})
        last_result = result
        if result.get("success"):
            return result
        log.info(f"[agent_write_and_run] attempt {attempt+1} failed → retrying with error feedback")
    return last_result or {"success": False, "stdout": "", "stderr": "no attempts ran", "exit_code": -99}


def _extract_python_code(raw: str) -> str:
    """Pull out the runnable Python from an LLM response, regardless of fences/prose."""
    import re
    s = (raw or "").strip()
    # 1. If there's a ```python ... ``` block, take the first one
    m = re.search(r"```(?:python|py)?\s*\n([\s\S]*?)```", s, re.I)
    if m:
        return m.group(1).strip()
    # 2. Strip any leading non-code prose: skip lines until we hit something that looks like Python
    code_starters = re.compile(
        r"^\s*(import |from |def |class |#|print\(|with |for |while |if |try:|chromadb\.|os\.|sys\.|httpx\.|"
        r"client\s*=|col\s*=|result\s*=|response\s*=|data\s*=|res\s*=|@|\"\"\"|''')"
    )
    lines = s.splitlines()
    for i, ln in enumerate(lines):
        if code_starters.match(ln):
            return "\n".join(lines[i:]).strip()
    # 3. Fallback: return whole thing
    return s
