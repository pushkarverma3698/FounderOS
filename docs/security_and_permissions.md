# Security & Failsafe Execution Limits

FounderOS V6 handles complex parallel LLM executions, meaning human loops cannot catch all errors manually. The system relies entirely on explicit code-level hooks, strict sandboxing boundaries, and Context-Window protection schemas directly inherited from the `Claude Code` deployment paradigms.

## 1. Tool Hooks (`tool_hooks.py`)
Previously we told LLM Agents "never delete files" inside their System Prompt. In FounderOS V6, rules are hardcoded into Python execution logic. Regardless of AI hallucinations, if a bad call attempts to bypass constraints, the hook intervenes.

### Pre-Tool Hooks (Before Execution)
Before an agent successfully launches `bash` or `chromadb_write`, it passes through strict regex filtering:
- **`ALWAYS_DENY_PATTERNS`**: Destructive payloads (`rm -rf /`, `DROP TABLE`, `sudo rm`) immediately cancel and return detailed refusal metrics without ever querying the host OS.
- **Data Silo Enforcement**: A script checking `registry.py` strictly prevents Turicks agents from opening `naggar_mem` files, isolating knowledge boundaries completely.
- **`ALWAYS_ALLOW_PATTERNS`**: Safe, deterministic commands (`ls`, `git diff`, `pwd`) automatically skip human-review processes and map into the execution loop rapidly.

### Post-Tool Hooks (Data Output Scrubbing)
Before the shell returns information back into the LLM context flow:
- **Secret Scrubbing**: API keys, open-source passwords, or Google Cloud signatures retrieved natively in code blocks are regex-replaced with `[REDACTED_API_KEY]`. The AI never gets a chance to see your root keys.
- **Size Limitation**: Anything exceeding 8000 characters is aggressively truncated, returning an `[...OUTPUT TRUNCATED...]` message. This prevents heavy log files from permanently breaking the context arrays in production loops.

## 2. Sandboxing & Worktree Modeling (`sandbox.py`)
All files that are subject to being mutated or edited heavily by implementation agents do not hit production code instantly.
Using `@run_in_worktree`, FounderOS physically clones the repository state into a `/tmp/` hidden folder. Agents freely manipulate, rewrite, or debug files dynamically here. To push changes to the primary repo, an explicit human response / `Coordinator` patch validation logic must approve the modified diffs.

## 3. The 4-Tier Permission Model
FounderOS allows varying layers of automation utilizing internal modes to set security boundaries dynamically:

- `PLAN`: The system is exclusively read-only. Perfect for outlining massive refactors.
- `DEFAULT`: The core operation standard. Actions like generating code proceed freely; actions involving deployment or massive data overwrite trigger a Telegram Approval.
- `AUTO`: Safe tools bypass human gates automatically utilizing Pre-Tool Hook fast-lanes.
- `BYPASS`: An exclusive flag given immediately to the Chairman enabling the AI 100% autonomous capacity to write anywhere instantly. 

## 5. Zero-Trust Tool Harness (V7)
Inspired by recent global breach vectors, V7 implements a strict **Zero-Trust Tool Harness**.
- **Model-Blind Enforcement**: Tools are no longer "aware" of the prompt context. They operate strictly on the `registry.py` permissions.
- **Per-Agent Tool Manifests**: Every agent is assigned an `allowed_tools` list (e.g., `["bash", "read_file"]`). If an agent (like `guest_crm`) attempts to call a tool outside its manifest (like `github_mcp`), `tool_hooks.py` kills the process instantly.
- **Hardware-Level Isolation**: Using Apple Silicon virtualization and internal process silos to ensure M4 hardware isolation for high-risk executions.

## 6. Autonomous Doc-Sync Integrity
The `doc_sync.py` agent acts as a final sanity check for security. 
- **Registry Auditing**: Every time the registry is modified, `doc_sync` cross-references the changes against the `security_and_permissions.md` file. 
- **Alerting**: If a permission change "downgrades" the security posture (e.g., giving a Nano agent `sudo` capacity), it triggers an immediate **URGENT SECURITY ALERT** to the Boardroom Telegram thread.

