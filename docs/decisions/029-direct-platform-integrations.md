# ADR-029: Direct Platform Integrations (Provider Abstraction Layer)

**Status:** Accepted · **Implemented** 2026-06-17  
**Supersedes:** ADR-028 phase-2/3 (gws + LinkedIn direct as defaults)  
**Context:** FounderOS used Composio as a unified OAuth middleware for Gmail, Calendar, and LinkedIn. For a single-tenant, admin-owned deployment, Composio adds cost, SDK drift risk, and response-shape surprises without proportional value. The founder directive: build for long-term stability — don't rewrite tools when a vendor changes.

## Decision

**Replace Composio as the default transport with direct platform APIs behind a provider abstraction layer.**

| Platform | Default backend | Legacy rollback |
|----------|----------------|-----------------|
| Gmail read/send | `gws` (Google Workspace CLI) | `GMAIL_BACKEND=composio` |
| Calendar create | `gws` | `CALENDAR_BACKEND=composio` |
| LinkedIn post | Direct Posts API (`LINKEDIN_ACCESS_TOKEN`) | `LINKEDIN_BACKEND=composio` |
| GitHub | Octokit + `GITHUB_TOKEN` (unchanged) | — |

**Architecture rule:** Tools (`src/tools/*.ts`) never import Composio or gws. They call `src/infra/providers/index.ts` dispatch functions. Provider adapters (`google-gws.ts`, `linkedin-direct.ts`, etc.) handle transport. Swap backends via env — departments, HITL wrappers, and prompts unchanged.

## Rationale

### Why direct APIs for admin single-tenant

1. **Stability** — One fewer vendor in the critical path. Composio SDK already migrated v1→v3 (410 Gone). Direct APIs + `gws` are the platforms' own contracts.
2. **Debuggability** — Real error messages from Gmail/LinkedIn, not Composio response-shape surprises.
3. **Cost** — No Composio billing for a deployment where the founder holds admin on every account.
4. **Long-term** — Provider abstraction means swapping `gws` → `googleapis` npm or Nango token vault later touches only `src/infra/providers/`, not 6 tool-wiring layers.

### Why keep Composio as rollback

Prod had ACTIVE connections (2026-06-16). Rollback env flags (`*_BACKEND=composio`) let us revert without a code deploy if direct path fails on Hetzner.

### Why not Nango/Arcade as default

Those solve multi-tenant OAuth at scale (Phase E). For admin-owned single-tenant, `gws auth login` + env-stored LinkedIn token is simpler. Nango remains the right choice when per-tenant connections ship.

## Implementation

```
src/tools/email.ts          → providerSendEmail()
src/tools/email-reader.ts   → providerReadEmails()
src/tools/calendar.ts       → providerCreateCalendarEvent()
src/tools/linkedin.ts       → providerLinkedInPost()

src/infra/providers/
  index.ts           — dispatch (env-selectable)
  google-gws.ts      — gws CLI (primary Google)
  google-composio.ts — Composio (rollback)
  linkedin-direct.ts — Posts API (primary LinkedIn)
  linkedin-composio.ts — Composio (rollback)
  types.ts           — stable contracts
```

### Auth setup (production runbook)

**Google (gws):**
```bash
npm install -g @googleworkspace/cli
gws auth login   # on Hetzner VPS as founderos user
```
For Workspace: service account + domain-wide delegation (super admin grants scopes once).

**LinkedIn (direct):**
1. Create LinkedIn Developer App → enable "Share on LinkedIn"
2. Founder OAuth → store `LINKEDIN_ACCESS_TOKEN` + `LINKEDIN_AUTHOR_URN` in `.env`
3. Refresh token before 60-day expiry (manual until token vault ships)

## Consequences

- Composio is optional — boot report shows "legacy fallback" not "required"
- Tests mock `src/infra/providers/` dispatch, not Composio internals
- Provider contract tests (e.g. Composio field names) live in `tests/unit/infra/providers/`
- Instagram (future): Meta Graph API direct — skip Composio entirely

## Addendum 2026-06-27 — `googleapis` backend (unattended default for prod)

The `gws` CLI backend needs an interactive `gws auth login` on the host (or a
gws profile dir), which is not "add keys and go" and broke prod (2026-06-27
audit: `gws_gmail down — gws not ready`, `GWS_BIN`/`GOOGLE_APPLICATION_CREDENTIALS`
unset; Composio rollback also dead via SDK drift → **email/calendar fully down**).

Added a third Google backend, `googleapis`, that authenticates with a Workspace
**service account + domain-wide delegation** (no CLI, no interactive login):

- `src/infra/providers/google-direct.ts` — `directSendEmail` / `directReadEmails`
  / `directCreateCalendarEvent`, identical signatures + `ToolResult` shapes to the
  gws adapter (drop-in at the provider layer; `comms.ts`, prompts, capability
  registry, and the suppression/quota/brand/judge/HITL rails are untouched).
- Selected via `GMAIL_BACKEND=googleapis` / `CALENDAR_BACKEND=googleapis`
  (`src/infra/providers/index.ts` 3-way dispatch; `provider-config.ts` parser).
- Credentials resolve through the existing account registry (ADR-036): one shared
  SA JSON (`GOOGLE_APPLICATION_CREDENTIALS`) + a per-account impersonation subject
  (`GOOGLE_SUBJECT_<ACCOUNT>`, fallback `GOOGLE_IMPERSONATE_SUBJECT`). Multi-company
  resolution is preserved.
- `/health` + boot smoke probe the active backend honestly (`googleapis_gmail`,
  `gmail_active`) — rule #22.

`gws` remains valid; `composio` remains the (now non-functional) legacy rollback.
**Prod default → `googleapis`** once the SA JSON + subject are provisioned.

Founder setup: see `.env.example` (Google section) — Workspace admin creates the
service account, enables domain-wide delegation for `gmail.send`, `gmail.readonly`,
`calendar.events`, drops the JSON on the host, sets the two env vars.

## References

- ADR-028 (hybrid migration plan — partially superseded)
- ADR-006 (auth strategy — Phase E may revisit Nango)
- ADR-009 (LinkedIn outreach ban — post-only regardless of provider)
- `src/infra/provider-config.ts` — env flags
- `src/infra/providers/google-direct.ts` — googleapis service-account adapter (2026-06-27)
