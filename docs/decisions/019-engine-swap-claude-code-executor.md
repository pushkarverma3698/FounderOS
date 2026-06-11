# ADR-019: Engine Swap — Claude Code as the Task Executor

**Status:** Accepted (2026-06-11)

## Context

Five hardening rounds (PRs #32, #33, #37, #43) fixed symptoms, but the 2026-06-09
live session still showed every failure class: engineering assembled a website
out of one-shot shell heredocs (broken `echo '\n'` files), ran `git checkout -b`
inside the live bot's own repo (committed website files into FounderOS and opened
a PR against it), fired ~10 approval cards 4 seconds apart for one task, answered
capability questions falsely ("no browser", "don't know what MCP is"), and wedged
the thread twice with Gemini 400 "contents is not specified" (3× /reset in 2h).

Root cause: FounderOS is a message **router** with shell access, asked to be a
task **executor**. The gap was filled by Gemini Flash improvising shell strings
with no verification loop. Per the 3-failed-fixes rule, that is an architecture
problem, not a prompt problem.

## Decision

Keep the chassis (Telegram gateway, supervisor routing, HITL interrupts,
idempotency audit, persistence). Swap the execution engine:

1. **claude_code is engineering's primary effector.** Any multi-step build/code/
   repo task is delegated WHOLE to the Claude Code CLI headless (`claude -p
   --output-format stream-json --permission-mode acceptEdits --allowedTools …`)
   — a real coding agent with file tools, shell, git, and a verify-iterate loop.
   Async spawn, 15-minute timeout, progress streamed to Telegram.
2. **One HITL approval per task.** The founder approves the task brief, not each
   shell command. project_workflow is demoted to read/status; heredoc/echo file
   writes are banned.
3. **Workspace isolation.** Default cwd `~/Projects/agent-workspace`; the
   FounderOS repo is hard-blocked for the executor (self-modification guard).
4. **Credential isolation.** `ANTHROPIC_*`/`CLAUDE*` env stripped from the child
   so the CLI uses its own login, not the bot's critic API key.
5. **Truthful capability manifest.** `src/agents/capabilities.ts` is the single
   dept→tool source; office.ts builds agents from it and the supervisor prompt
   embeds the auto-generated manifest. Capability claims can no longer drift.
6. **Airtight Gemini sanitizer.** `sanitizeForGemini` can no longer emit an
   invalid contents array (all-empty → synthetic human turn; system-only →
   appended user turn); the stream path is sanitized; an empty-contents 400 now
   logs message-shape diagnostics and retries once with minimal recovery context
   instead of wedging the thread.

## Consequences

- The supervisor/departments stop pretending to be a coding agent; they route,
  research, communicate, and remember — which they do reliably.
- Engineering tasks inherit Claude Code's quality (strong model, read-back
  verification) at zero marginal engineering cost.
- One-time setup: the CLI must be logged in on the host (`claude` → `/login`).
- Probes: `scripts/probe-executor-routing.ts` pins the one-approval contract;
  capability questions verified truthful through the live office.
