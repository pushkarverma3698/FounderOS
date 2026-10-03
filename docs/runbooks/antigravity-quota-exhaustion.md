# Runbook: Antigravity Quota Exhaustion

This runbook outlines operational procedures and expected autonomous behaviors when Google Antigravity models or API providers encounter quota exhaustion (`RESOURCE_EXHAUSTED` / HTTP 429).

---

## 1. How to Check Model Quota Status

Quota limits apply per model family on the Antigravity account login (e.g., Claude family vs. Gemini family).

### Probe Model Status via CLI
To test whether a specific model has available quota on the VPS:

```bash
# List all available models
sudo -u antigravity -i agy models

# Probe a specific model with a minimal execution
sudo -u antigravity -i agy --new-project --model <model-name> --print "reply ok" --output-format text
```

### Inspect System Down & Pause States
When quota is exhausted, system daemons record pause timestamps on disk:

```bash
# Executor pause: the file holds the reset time as epoch seconds (absent = not paused)
date -u -d @"$(cat ~/.claude/agent-dispatch.quota-until)"

# Check reviewer down state (if all candidate models are exhausted)
cat ~/.claude/pr-brain.down
```

### What it looked like on 2026-10-02 (measured on the VPS)
- `claude-sonnet-4-6`, `claude-opus-4-6-thinking` and `gpt-oss-120b-medium` all answered `RESOURCE_EXHAUSTED (code 429) ... Resets in 69h26m28s`.
- The Gemini models shared one window: from about 20:05 to 20:57 UTC both `gemini-3.1-pro-high` (reviewer) and `gemini-3.6-flash-medium` (executor) were out, then both worked again.
- A one-word probe can succeed while a real review is refused: a quota can be too small for a long prompt and still answer a short one.

### Log Classification Mechanism
`deploy/lib/agy-failure.sh` automatically detects quota errors by matching patterns in CLI failure logs (such as `RESOURCE_EXHAUSTED (code 429)` or `Individual quota reached... Resets in <duration>`).

---

## 2. Autonomous System Behaviors & Fallbacks

The autonomous system handles quota exhaustion gracefully without crashing or losing work.

### A. Executor (`agent-dispatch`)
- **Issue Handling:** Reverts the current issue back to `agent:ready` state so no attempt count is consumed.
- **Pause & Lock:** Writes the reset epoch to `~/.claude/agent-dispatch.quota-until` and pauses dispatching new tasks.
- **Notification:** The run's own Telegram message ends with `Quota exhausted until <time>`, and one separate notice says the same. Nothing more is sent until it resumes.
- **Recovery:** Automatically resumes dispatching tasks on subsequent cron ticks once the reset timestamp passes.

### B. Reviewer (`pr-brain`)
- **Engine Configuration:** Controlled via `PR_BRAIN_ENGINE` (`agy` by default, `claude` as alternative).
- **Model Fallback Chain (`agy` engine):** Evaluates candidate models defined in `PR_BRAIN_MODELS` (e.g., `claude-sonnet-4-6`, `gemini-3.1-pro-high`).
- **Independence Safety:** Automatically skips any model matching the executor's model (`PR_BRAIN_EXECUTOR_MODEL`, e.g. `gemini-3.6-flash-medium`) to adhere to ADR-046 independent review guidelines.
- **Fallback Progression:** If a model hits quota exhaustion mid-preflight or mid-sweep, `pr-brain` automatically switches to the next candidate model in the chain.
- **Full Exhaustion:** If all candidate models in `PR_BRAIN_MODELS` are exhausted:
  - Records state in `~/.claude/pr-brain.down`.
  - Sends a single Telegram notification naming the models attempted and the reset window.
  - Pauses review sweeps until quota resets, retrying silently on future cron intervals.

---

## 3. Required Founder Interventions

### Option A: Wait for Reset (Zero Intervention)
- No manual action is required. The system will automatically resume operations when the quota reset timestamp expires.

### Option B: Sign in with an account that has quota
If immediate restoration is required (`agy` has no login subcommand; it asks to sign in when started):
1. On the VPS, open the antigravity user's shell, run `agy` once, sign in with the other Google account, then quit it:
   ```bash
   sudo -u antigravity -i
   agy
   ```
2. Clear the pause files so the next cron tick retries at once:
   ```bash
   rm -f ~/.claude/agent-dispatch.quota-until ~/.claude/pr-brain.down
   ```

### Option C: Switch Reviewer Engine or Models
- **Switch Engine:** Change `PR_BRAIN_ENGINE=claude` in crontab (`crontab -e`) to use Anthropic Claude directly instead of Antigravity CLI.
- **Override Models:** Set `AGENT_DISPATCH_MODEL` or `PR_BRAIN_MODELS` in environment/crontab to utilize model families with available quota.
