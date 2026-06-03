# ADR-012: Personal Department (laptop operator) with HITL + path-guard

- **Status:** Accepted (2026-06-03)
- **Context branch:** `feat/personal-department`

## Context
The founder wants FounderOS to handle personal-machine work: read/edit files, run scripts,
and drive the browser — a "senior engineer on my laptop" reachable from Telegram. This is the
highest-risk capability in the system: a Telegram-driven LLM that already ingests untrusted
email/web content gaining filesystem + shell + browser control is a prompt-injection → RCE/exfil
surface.

## Decision
Add a 7th department `personal` (ReAct agent) with five tools. Safety is layered:
1. **HITL `interrupt()`** on every write/shell/browser action (reads are ungated).
2. **`path-guard`** confines file paths + shell cwd to `$HOME` (`PERSONAL_ROOT` override) and
   denies secret/system paths even on read.
3. **Danger heuristic** surfaces catastrophic shell patterns in the approval card.

Scope = home directory (not whole PC). Browser = AppleScript MVP. Full Safari-MCP client
integration is **deferred to Phase 2** to avoid destabilizing a stabilization pass (it needs a
GUI session + macOS Automation/Screen-Recording grants for the headless node process).

## Alternatives rejected
- **Whole-PC unrestricted** — unacceptable blast radius for an injection-exposed agent.
- **Full Safari-MCP subprocess now** — heavy, extra perms, new long-lived subprocess; deferred.
- **Gate only "destructive" actions** — "destructive" judged by the LLM; weak vs injection.
  We gate all writes/shell/browser.

## Consequences
- More Telegram taps (every action approved) — accepted; the founder is the control.
- New pure, well-tested safety unit (`path-guard`) reusable if a sandbox mode is added later.
- Supersedes nothing; extends the v2 office (ADR-010) from 6 → 7 departments.
