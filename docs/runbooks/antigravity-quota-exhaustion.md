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
# Check executor pause status and reset timestamp
cat ~/.claude/agent-dispatch.quota-until

# Check reviewer down state (if all candidate models are exhausted)
cat ~/.claude/pr-brain.down
```

### Log Classification Mechanism
`deploy/lib/agy-failure.sh` automatically detects quota errors by matching patterns in CLI failure logs (such as `RESOURCE_EXHAUSTED (code 429)` or `Individual quota reached... Resets in <duration>`).

---

## 2. Autonomous System Behaviors & Fallbacks

The autonomous system handles quota exhaustion gracefully without crashing or losing work.

### A. Executor (`agent-dispatch`)
- **Issue Handling:** Reverts the current issue back to `agent:ready` state so no attempt count is consumed.
- **Pause & Lock:** Writes the reset epoch to `~/.claude/agent-dispatch.quota-until` and pauses dispatching new tasks.
- **Notification:** Sends exactly **one** Telegram notification stating that execution is paused and providing the reset time.
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

### Option B: Re-authenticate with a Fresh Account
If immediate restoration is required:
1. Log into VPS and authenticate Antigravity with an account having active quota:
   ```bash
   sudo -u antigravity -i agy auth login
   ```
2. Clear active pause state files to trigger immediate retry:
   ```bash
   rm -f ~/.claude/agent-dispatch.quota-until ~/.claude/pr-brain.down
   ```

### Option C: Switch Reviewer Engine or Models
- **Switch Engine:** Change `PR_BRAIN_ENGINE=claude` in crontab (`crontab -e`) to use Anthropic Claude directly instead of Antigravity CLI.
- **Override Models:** Set `AGENT_DISPATCH_MODEL` or `PR_BRAIN_MODELS` in environment/crontab to utilize model families with available quota.
