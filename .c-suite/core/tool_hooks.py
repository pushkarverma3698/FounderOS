"""
FounderOS — Tool Hooks (v1.0)
==============================
Pre/post tool execution enforcement layer.

Borrowed from: Claude Code `src/hooks/toolPermission/PermissionContext.ts`
Pattern: Hook chain runs BEFORE any tool execution — allow / deny / modify.

WHY: FounderOS previously enforced data silo rules only via system prompts
     (easily bypassed by confused models). This adds CODE-LEVEL enforcement
     that cannot be overridden by the LLM.

Key enforcements:
  1. Data silo: Turicks agents ≠ Naggar data (and vice versa)
  2. Forbidden bash patterns: rm -rf /, DROP TABLE, sudo rm, etc.
  3. Secret scrubbing: API keys never reach the LLM in tool results
  4. Private data: guest PII and client code → local model only

Usage:
    from core.tool_hooks import pre_tool_hook, post_tool_hook, HookResult

    # Before running any tool:
    hook = pre_tool_hook("bash", "git status", agent_name="senior_dev")
    if hook.behavior == "deny":
        raise PermissionError(hook.reason)

    # After tool runs, sanitize output:
    clean_output = post_tool_hook("bash", raw_output, agent_name="senior_dev")
"""

import re
import logging
from dataclasses import dataclass

log = logging.getLogger("ToolHooks")


# ─── Result Type ──────────────────────────────────────────────────────────────

@dataclass
class HookResult:
    """Result of a pre-tool permission check."""
    behavior: str           # "allow" | "deny" | "modify" | "require_approval"
    modified_input: str | None = None  # If "modify", the sanitized input
    reason: str = ""


# ─── Forbidden Patterns (HARD DENY — no override) ────────────────────────────

ALWAYS_DENY_PATTERNS = [
    r"rm\s+-rf\s+/",           # rm -rf /
    r"rm\s+-rf\s+~",           # rm -rf ~
    r"DROP\s+TABLE",            # SQL table destruction
    r"DROP\s+DATABASE",
    r"DELETE\s+FROM\s+\w+\s*;?\s*$",  # DELETE without WHERE
    r"sudo\s+rm",               # sudo rm anything
    r"chmod\s+777\s+/",         # chmod 777 on root
    r">\s*/dev/sd",             # Writing to raw disk
    r"mkfs\.",                  # Formatting filesystem
    r"dd\s+if=.*of=/dev/sd",    # dd to block device
    r"shutdown",                # System shutdown
    r"reboot",                  # System reboot
]

# Patterns that are always safe — skip human/hook review (fast path)
ALWAYS_ALLOW_PATTERNS = [
    r"^git\s+(-C\s+\S+\s+)?(status|log|diff|branch|show)",  # git log, git -C path log
    r"^ls(\s|$)",
    r"^cat\s+",
    r"^head\s+",
    r"^tail\s+",
    r"^find\s+",
    r"^grep\s+",
    r"^wc\s+",
    r"^pwd$",
    r"^echo\s+",
    r"^python\s+-m\s+pytest",
    r"^python\s+-c\s+['\"]print",
    r"^pip\s+(list|show|freeze)",          # package listing
    r"^\S+/pip\s+(list|show|freeze)",      # venv pip list
    r"^file\s+",                           # file type check
]

# Dynamically loaded via registry now
from core.registry import get_agent, get_all_companies
# Secret patterns to scrub from tool output before LLM sees it
SECRET_PATTERNS = [
    (r'(api[_\-]?key|apikey)["\s:=]+["\']?[\w\-]{20,}', "[REDACTED_API_KEY]"),
    (r'(password|passwd|pwd)["\s:=]+["\']?[\w\-@#$!]{6,}', "[REDACTED_PASSWORD]"),
    (r'(secret|token)["\s:=]+["\']?[\w\-]{16,}', "[REDACTED_TOKEN]"),
    (r'sk-[a-zA-Z0-9\-]{15,}', "[REDACTED_SK_KEY]"),    # OpenAI/Claude keys
    (r'AIza[a-zA-Z0-9_\-]{20,}', "[REDACTED_GOOGLE_KEY]"),  # Google keys
]


# ─── Pre-Tool Hook ────────────────────────────────────────────────────────────

def pre_tool_hook(
    tool_name: str,
    tool_input: str,
    agent_name: str = "",
    collection_name: str = "",
) -> HookResult:
    """
    Runs BEFORE any tool execution. Returns allow / deny / modify.

    Claude Code pattern (PermissionContext.ts → runHooks):
      Layer 1: ALWAYS_DENY hard blocks (no override possible)
      Layer 2: Data silo enforcement (code-level, not system prompt)
      Layer 3: ALWAYS_ALLOW fast path (skip human review for known-safe ops)
      Layer 4: Default allow (let upstream logic decide)

    Args:
        tool_name: The tool being called (e.g., "bash", "chromadb_write")
        tool_input: The command/query/payload the tool will execute
        agent_name: The agent making the call
        collection_name: ChromaDB collection being accessed (if applicable)

    Returns:
        HookResult with behavior "allow", "deny", or "modify"
    """
    # ── Layer 1: Hard denials — cannot be overridden ──────────────────────────
    for pattern in ALWAYS_DENY_PATTERNS:
        if re.search(pattern, tool_input, re.IGNORECASE):
            reason = f"Forbidden pattern matched: {pattern}"
            log.warning(f"[ToolHook] DENY {agent_name}/{tool_name}: {reason}")
            return HookResult("deny", reason=reason)

    # ── Layer 2: Tool Manifest Enforcement (Zero-Trust) ──────────────────────
    agent_config = get_agent(agent_name)
    if agent_config:
        if tool_name not in agent_config.allowed_tools:
            reason = f"Zero-Trust Violation: {agent_name} is not authorized to use tool '{tool_name}' for input: {tool_input[:50]}..."
            log.warning(f"[ToolHook] MANIFEST_DENY {agent_name}: {reason}")
            return HookResult("deny", reason=reason)

    # ── Layer 3: Data silo enforcement ────────────────────────────────────────
    allowed_collections = agent_config.allowed_collections if agent_config else []

    if collection_name:
        if collection_name not in allowed_collections:
            reason = (
                f"Data silo violation: {agent_name} attempted to access "
                f"'{collection_name}' but is only allowed: {allowed_collections}"
            )
            log.warning(f"[ToolHook] SILO_DENY {agent_name}: {reason}")
            return HookResult("deny", reason=reason)

    # Cross-company shortcut: Prevent querying other company's database in raw text
    for comp in get_all_companies():
        # If the agent DOES NOT belong to this company, AND isn't cross-company
        if agent_config and agent_config.company_assignment != "cross" and agent_config.company_assignment != comp.name:
            if comp.memory_collection in tool_input:
                reason = f"Data silo: {agent_name} cannot access {comp.memory_collection}"
                log.warning(f"[ToolHook] SILO_DENY: {reason}")
                return HookResult("deny", reason=reason)

    # ── Layer 3: Fast-path allow for known-safe patterns ──────────────────────
    for pattern in ALWAYS_ALLOW_PATTERNS:
        if re.match(pattern, tool_input.strip(), re.IGNORECASE):
            log.debug(f"[ToolHook] FAST_ALLOW {agent_name}/{tool_name}: matched safe pattern")
            return HookResult("allow", reason="Known-safe pattern")

    # ── Layer 4: Destructive action gating (Zero-Trust Harness) ────────────────
    if PermissionMode.is_destructive(tool_name, tool_input):
        log.warning(f"[ToolHook] REQUIRE_APPROVAL {agent_name}/{tool_name}: destructive action")
        return HookResult("require_approval", reason=f"Destructive action requires /approve: {tool_input}")

    # ── Layer 5: Default allow ─────────────────────────────────────────────────
    log.debug(f"[ToolHook] ALLOW {agent_name}/{tool_name}")
    return HookResult("allow")


# ─── Post-Tool Hook ───────────────────────────────────────────────────────────

def post_tool_hook(
    tool_name: str,
    result: str,
    agent_name: str = "",
) -> str:
    """Sanitize results before LLM sees them."""
    sanitized = result
    for pattern, replacement in SECRET_PATTERNS:
        sanitized = re.sub(pattern, replacement, sanitized, flags=re.IGNORECASE)
    if len(sanitized) > 8000:
        sanitized = str(sanitized)[:8000] + "\n\n[...OUTPUT TRUNCATED FOR CONTEXT EFFICIENCY...]"
    return sanitized

def scrub_prompt(prompt: str) -> str:
    """
    V7.1 Privacy Layer: Sanitizes prompts before they are sent to 
    external/unsecured tiers (like Apple Intelligence / Siri Shortcut).
    Redacts internal file paths and secrets.
    """
    # Redact absolute paths to FounderOS
    sanitized = prompt.replace("/Users/pushkarverma/Documents/Coding stuff/FounderOS", "[FOUNDEROS_ROOT]")
    # Apply standard secret scrubbing
    for pattern, replacement in SECRET_PATTERNS:
        sanitized = re.sub(pattern, replacement, sanitized, flags=re.IGNORECASE)
    return sanitized


# ─── Permission Mode ──────────────────────────────────────────────────────────

class PermissionMode:
    """
    Claude Code permission tiers (from PermissionContext.ts).
    Controls how aggressively agents can act without human approval.
    """
    PLAN    = "plan"     # Read-only, no execution — safe for planning mode
    DEFAULT = "default"  # Destructive ops need Telegram approval
    AUTO    = "auto"     # Trust pre-approved safe patterns, skip approval
    BYPASS  = "bypass"   # Chairman-only: full autonomous power

    @staticmethod
    def is_destructive(tool_name: str, tool_input: str) -> bool:
        """Returns True if this tool call could mutate state."""
        import re as _re
        # bash: check against ALWAYS_ALLOW_PATTERNS first
        if tool_name == "bash":
            for pat in ALWAYS_ALLOW_PATTERNS:
                if _re.match(pat, tool_input.strip(), _re.IGNORECASE):
                    return False  # Read-only — never requires approval
            return True  # Unknown bash → treat as destructive
        mutating_tools = {"chromadb_write", "file_write", "telegram_send"}
        return tool_name in mutating_tools
