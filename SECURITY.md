# Security Policy

FounderOS takes **real actions** — it sends email, posts to LinkedIn, writes
files, runs shell commands, pushes to GitHub, and can operate a production VPS.
Security is therefore a core design property, not an afterthought. This document
covers how to report issues and the controls that are built in.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue.

- Preferred: GitHub **private vulnerability reporting** on this repository
  (Security → Report a vulnerability).
- Alternative: email the maintainer via [turicks.com](https://turicks.com).

Include a description, reproduction steps, and impact. We aim to acknowledge
within 72 hours. Please give us reasonable time to remediate before any public
disclosure.

## Supported versions

FounderOS is deployed as a single production instance (branch `main` → Hetzner
VPS). Security fixes land on `main`. There is no back-port branch.

## Built-in security controls

| Control | Where | What it protects |
|--------|-------|------------------|
| **Human-in-the-loop on every external action** | `src/infra/hitl.ts`, `HITL_GATED_TOOLS` (17 tools) | Nothing is sent, written, spent, or deployed without explicit founder approval. |
| **Idempotency before every send** | `src/kernel/tool-adapter.ts`, `src/infra/hitl.ts` | A deterministic, tenant-scoped, content-addressed key (`{prefix}:{tenant}:{sha1(parts)}`) is checked against `action_log` before any external side effect — a retry can never double-send. |
| **Path-guard on file/shell tools** | `src/infra` path safety | File access is `$HOME`-confined; `.ssh`, `.env`, `*.pem`, `/etc` are blocked even on read. |
| **Least privilege per worker** | `src/agents/capabilities.ts` | The `personal` worker's shell/file/browser access is isolated from business workers; each worker carries only the tools it needs. |
| **Zero-hallucination receipts** | `validateStepResult` | An action claim without a code-recorded successful receipt is rejected — the agent cannot *say* it did something it didn't. |
| **Secrets are env-only** | `src/core/config.ts`, `src/infra/composio.ts` | No credentials in source. Missing required secrets fail loudly at startup. |
| **Audit trail** | `action_log` (Postgres) | Every action is written with tenant + idempotency key on real success only. |
| **Budget caps** | `src/infra/budget.ts`, `daily-budget` | Per-run and per-day USD ceilings bound blast radius and cost. |
| **Determinism** | temperature 0, pure routing | Behavior is reproducible; routing/guards are unit-tested code, not prompt text. |
| **Read-only external surface** | `src/mcp/` | The MCP server exposes reads only — no write path for external clients. |

Full trust-boundary and attack-surface analysis: [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## Secret handling

- Never commit secrets. `.env` is git-ignored; production config is delivered via
  an encrypted GitHub secret, not stored in the repo.
- Required secrets are validated at boot; the process refuses to start without
  them rather than failing open.
- If a secret is ever exposed, rotate it immediately and treat any dependent
  external account as compromised until rotated.

## Recommended repository hardening

Maintainers should keep these GitHub features enabled: Dependabot alerts, secret
scanning + push protection, code scanning, and private vulnerability reporting.
