# ADR-028: Composio vs Direct CLIs (gws, gh, LinkedIn API)

**Status:** Accepted  
**Date:** 2026-06-16  
**Context:** FounderOS uses Composio for Gmail, Google Calendar, and LinkedIn. GitHub already uses Octokit + `GITHUB_TOKEN`. The founder asked whether to remove Composio and standardize on direct CLIs (`gws` for Google Workspace, similar for LinkedIn).

## Decision

**Hybrid — do not big-bang replace Composio.** Migrate Google services to `gws` incrementally when a concrete pain justifies it. Keep Composio for LinkedIn until a direct API path is wired with the same HITL + idempotency guarantees. GitHub stays on Octokit (already the right pattern).

## Rationale

| Integration | Today | Recommendation |
|-------------|-------|----------------|
| **GitHub** | Octokit + `GITHUB_TOKEN` | Keep — works, HITL-gated, no middleman |
| **Gmail + Calendar** | Composio (`GMAIL_*`, `GOOGLECALENDAR_*`) | **Consider `gws`** for reads + sends when prod OAuth is on the VPS |
| **LinkedIn** | Composio (`LINKEDIN_CREATE_LINKED_IN_POST`) | **Keep Composio** short-term — no stable `gws`-equivalent; direct API needs URN + OAuth maintenance |
| **Shell / laptop** | `run_shell` (personal dept) | Keep — already CLI-native, HITL-gated |

### Why not rip out Composio now

1. **It works on prod** — Gmail ACTIVE, LinkedIn ACTIVE, HITL + audit rows verified live (2026-06-16).
2. **One OAuth dashboard** — connection IDs + entity IDs are wired; replacing means re-auth on Hetzner + new failure modes.
3. **LinkedIn has no `gws`** — would need direct Marketing API + author URN handling; Composio already abstracts this.
4. **Rewrite cost ≠ stability cost** — the bugs we hit were routing/hallucination/data-empty, not Composio HTTP failures.

### When `gws` is worth it (Google only)

Use [`googleworkspace/cli`](https://github.com/googleworkspace/cli) when **all** of these are true:

- Composio becomes a recurring outage (expired connections, SDK drift, billing)
- You want **structured JSON** from Gmail/Calendar/Drive without Composio's response-shape surprises
- Prod VPS has **`gws auth login`** (or exported credentials) in the deploy runbook
- You implement the **same** FounderOS tool bar: Zod boundary, idempotency, HITL before send, soft-failure detection

Suggested migration order:

1. **`read_emails`** → `gws gmail …` (read-only, no HITL) — lowest risk
2. **`create_calendar_event`** → `gws calendar …`
3. **`send_email`** → `gws gmail send` (keep HITL gate unchanged in `agent-tools/comms.ts`)

Implementation pattern: new `src/tools/gmail-gws.ts` behind env flag `GMAIL_BACKEND=gws|composio` (default `composio` until prod-verified). Same wrapper surface — departments unchanged.

### LinkedIn

Do **not** replace with a generic CLI unless you find a maintained, OAuth-complete tool. Options:

- Keep Composio (current)
- Direct LinkedIn Marketing API in `src/tools/linkedin-direct.ts` (more control, more OAuth work)
- Browser automation via personal dept (already exists; worse for reliability)

### Other accounts

- **Instagram:** Composio connection exists but no tool is wired — defer until marketing needs it.
- **Composio GitHub env vars:** Aspirational only; **use `GITHUB_TOKEN`**.

## Consequences

- Short term: fix Composio *callers* (fast-path inbox read, response parsing, guards) — not the provider.
- Medium term: spike `gws` for Gmail read on prod; compare latency + response shape vs Composio.
- Long term: SaaS phase may still need per-tenant OAuth — Composio or Google service accounts; decision revisited in Phase E.

## References

- ADR-006 (auth strategy)
- `src/infra/composio.ts`
- Live evidence: 2026-06-16 cloud agent session (HITL shell + GitHub issue #96)
