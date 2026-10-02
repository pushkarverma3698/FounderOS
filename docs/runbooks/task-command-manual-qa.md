# Runbook: Manual QA Test for `/task` Command Agentic Loop

This runbook defines the manual QA verification procedure for the Telegram `/task` command and the end-to-end autonomous engineering loop in FounderOS (`Telegram → Kernel → GitHub Issue → agent-dispatch → Headless Antigravity → Draft PR → pr-brain Review`).

---

## 1. Prerequisites & Environment Setup

Before starting manual QA, verify the following prerequisites on the environment (local dev or VPS):

1. **Telegram Gateway Operational**:
   - `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` configured in `.env`.
   - Bot running locally (`pnpm dev:jarvis-local` or `pnpm start`) or via systemd (`founderos.service`).
2. **Headless Antigravity & Dispatcher**:
   - `agent-dispatch` daemon running (or invokable via `bash ~/Projects/scripts/ai-tools/agent-dispatch`).
   - Headless `agy` CLI binary installed at `~/.local/bin/agy`.
3. **Repository Allowlist**:
   - Target repository must be registered in `DISPATCH_REPO_ALLOWLIST` (or registered via `/newproject`).

---

## 2. End-to-End Test Execution Flow

### Step 1: Initiating `/task` from Telegram

1. Open the Telegram chat with the FounderOS bot.
2. **Test Case 1A (Bare `/task`)**:
   - Input: `/task fix typo in docs/README.md`
   - Expected Output: The bot responds with interactive inline keyboard buttons prompting for repository selection (e.g. `pushkarverma3698/FounderOS`).
3. **Test Case 1B (Explicit Repo Hint `/task repo:<hint>`)**:
   - Input: `/task repo:founderos update documentation for manual QA`
   - Expected Output: Pre-selects `pushkarverma3698/FounderOS` without repository picker prompt.
4. **Test Case 1C (Invalid / Unallowlisted Repo)**:
   - Input: `/task repo:unknown-repo do something`
   - Expected Output: Refusal message citing allowed repositories list.

### Step 2: Brief Expansion & Human-in-the-Loop (HITL) Approval

1. Upon repository selection/resolution, the kernel expands the natural language request into a structured brief.
2. The Telegram bot presents an **HITL Approval Card**:
   - Target Repository: `pushkarverma3698/FounderOS`
   - Goal, Scope, Verification commands, and Constraints formatted.
   - Action Buttons: `[Approve]` | `[Reject]`
3. Tap **`[Approve]`**.
4. Expected Output:
   - Card updates state to approved.
   - GitHub Issue created with label `agent:ready`.
   - `dispatch-tick` kick signal emitted to wake the dispatcher daemon.

### Step 3: Issue Intake & Dispatch (`agent-dispatch`)

1. Verify issue created on GitHub:
   - Label: `agent:ready`
   - Body matches `.github/ISSUE_TEMPLATE/agent-task.md` template structure.
2. `agent-dispatch` claims the issue:
   - Appends comment `<!-- agent-claimed: <ISO> -->`.
   - Changes label from `agent:ready` to `agent:working`.

### Step 4: Headless Antigravity Execution

1. `agent-dispatch` invokes `agy --new-project --print` in isolated workspace `/opt/agy-workspace/founderos`.
2. Antigravity executes the 20-step issue-driven contract:
   - Inspects issue and repo context.
   - Cuts task-specific branch: `task/issue-<N>-<slug>`.
   - Implements changes in scope.
   - Runs verification command (e.g. `pnpm lint`, `pnpm test`, or `pnpm gate`).
   - Pushes branch to origin.
   - Opens a **Draft PR** targeting `main` (or integration branch `beta`).
   - References original issue (e.g. `Fixes #<N>`).

### Step 5: Automated Review (`pr-brain`)

1. `pr-brain` daemon detects open Draft PR.
2. Executes `pr-adversary` review skill.
3. Verdict outcomes:
   - **PASS**: PR approved for human merge.
   - **NON-BLOCKER**: Advisory feedback added as PR comment.
   - **BLOCKER — Needs Decision**: Issues returned to Pass B for re-dispatch (`<!-- agent-attempt: N -->`).

---

## 3. Manual QA Verification Checklist

| Check # | Verification Point | Expected Result | Pass / Fail |
|---|---|---|---|
| **V-01** | `/task` command syntax parsing | Parsed correctly; bare `/task` displays repo picker buttons | [ ] |
| **V-02** | Repo allowlist enforcement | Unallowed repo hints rejected cleanly without side effects | [ ] |
| **V-03** | HITL approval card rendering | Renders structured goal, scope, and verification details | [ ] |
| **V-04** | GitHub Issue creation | Issue created with `agent:ready` label and standard brief layout | [ ] |
| **V-05** | `agent-dispatch` claim | Relabeled to `agent:working` with active lease timestamp | [ ] |
| **V-06** | Branch naming convention | Branch named `task/issue-<N>-<slug>` cut from `origin/main` | [ ] |
| **V-07** | Draft PR creation | Draft PR opened targeting base branch (`main` or `beta`) | [ ] |
| **V-08** | PR Body Compliance | Body contains **What changed**, **How it was verified**, and **NOT VERIFIED** | [ ] |
| **V-09** | CI fitness gate | `pnpm lint` and CI fitness checks green | [ ] |
| **V-10** | Non-auto-merge invariant | Antigravity never auto-merges; PR remains awaiting human review | [ ] |

---

## 4. Troubleshooting & Operational Edge Cases

- **Stale Lease Recovery**: If an issue remains in `agent:working` for >45 minutes without an open PR, `agent-dispatch` releases lease back to `agent:ready`.
- **Attempt Budget Exceeded**: At `N >= 3` review attempts, issue moves to `agent:blocked` (terminal state) and alerts founder on Telegram.
- **`pr-brain` Authentication Failure**: Check `claude` CLI authentication on VPS (`claude -p "say ok"`).
