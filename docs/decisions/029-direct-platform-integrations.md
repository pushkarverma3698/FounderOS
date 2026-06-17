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

## References

- ADR-028 (hybrid migration plan — partially superseded)
- ADR-006 (auth strategy — Phase E may revisit Nango)
- ADR-009 (LinkedIn outreach ban — post-only regardless of provider)
- `src/infra/provider-config.ts` — env flags
