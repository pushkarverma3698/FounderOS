# Agent setup templates

Sanitized copies of the founder's laptop settings for Claude Code and Antigravity, audited 2026-10-04
([audit](../../docs/plans/2026-10-04-agent-setup-and-pipeline-audit.md)). They hold no secrets and no machine state.

| File | Applies to | Notes |
|---|---|---|
| `claude-settings.template.json` | `~/.claude/settings.json` | Allows keep the workflow (pnpm, gh, curl, node, `ssh founderos-vps`); denies cover credentials, `.env` and shell reads of keys. Sandbox stays off: it would break ssh, docker and git credentials. |
| `antigravity-config.template.json` | `~/.gemini/config/config.json` | Grants scoped to `~/Projects` and `~/Oplify.in`. Expand `~` to the absolute path when applying. |

CI enforces the invariants (`tests/unit/governance/agent-setup-templates.test.ts`): no wildcard grants, no secrets,
required denies present. Live-vs-template drift is checked on the laptop by `~/Projects/scripts/ai-tools/verify-agent-setup`
(laptop-only, so it cannot run in CI). Two Antigravity fields are not in the file: set terminal execution to Request
Review and non-workspace file access to off in the app's settings.
