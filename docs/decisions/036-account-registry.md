# ADR-036: Integration Account Registry

**Status:** Accepted · **Implemented** 2026-06-21  
**Supersedes:** partial ADR-006 (Composio-as-universal-OAuth for internal phase)  
**Builds on:** ADR-029 (provider abstraction layer)

## Context

FounderOS operates multiple brand identities (`turicks`, `personal`, `naggar`) across Google (Gmail/Calendar), LinkedIn, Instagram, Facebook, and GitHub. Composio previously held multiple Gmail connection IDs, but switching accounts required env var hacks (`COMPOSIO_GMAIL_CONN_ID`). The direct API path (gws + LinkedIn direct) only supported a single `userId: "me"` identity.

Departments need deterministic routing: sales → turicks Gmail, jobhunt → personal Gmail, marketing → turicks LinkedIn.

## Decision

**Add a Postgres-backed account registry + deterministic department routing. Secrets stay in `.env` and on-disk gws profiles; the DB stores only credential references.**

### Architecture (3 layers — complexity stays low)

```
┌─────────────────────────────────────────────────────────────┐
│  Tools (email, linkedin, calendar)                          │
│  Pass: department, optional account_key                     │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  Account registry (src/infra/account-registry.ts)           │
│  resolveAccountKey(department, platform) → account_key      │
│  Load credential_refs from DB or convention defaults          │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  Provider adapters (google-gws, linkedin-direct, …)           │
│  Read secrets via credential-resolver.ts                      │
│  Unchanged HITL + idempotency at tool layer                   │
└───────────────────────────────────────────────────────────────┘
```

### Account keys

| Key | Use |
|-----|-----|
| `turicks` | Business Gmail, Turicks LinkedIn, marketing social |
| `personal` | Job applications, personal Gmail/LinkedIn |
| `naggar` | Naggar Retreat Google + Meta pages |

### Department → account defaults (deterministic code)

| Department | Google | LinkedIn | Instagram/Facebook |
|------------|--------|----------|-------------------|
| sales, marketing, comms, research | turicks | turicks (marketing) | turicks |
| jobhunt, personal | personal | personal | personal |
| engineering | — | — | — (GitHub: turicks PAT) |

Agents may override with explicit `account_key` on `send_email`.

### Credential storage rule

**Never store raw OAuth tokens in Postgres (v1).** Store refs:

```json
{
  "access_token_env": "LINKEDIN_ACCESS_TOKEN_TURICKS",
  "author_urn_env": "LINKEDIN_AUTHOR_URN_TURICKS",
  "gws_profile_dir": "/home/founderos/.founderos/accounts/turicks/gws"
}
```

Phase E (SaaS): swap refs to Nango connection IDs — providers unchanged.

### Multi-profile gws

Each account gets an isolated directory:

```
~/.founderos/accounts/turicks/gws/   ← gws auth login (turicks@gmail)
~/.founderos/accounts/personal/gws/  ← gws auth login (personal@gmail)
```

`runGws()` sets `GWS_CONFIG_HOME` per call.

### Composio

Remains **rollback only** (`*_BACKEND=composio`). Registry stores per-account Composio connection id env refs when rollback is needed.

### Instagram / Facebook

No tools wired yet. Registry rows + `meta_graph` auth backend are seeded so marketing tools can be added behind the same pattern (ADR-029 wiring map).

## Consequences

- `pnpm accounts:seed` + manual auth runbook required once per environment
- `pnpm accounts:status` shows missing env vars per account
- `pnpm accounts:verify` proves department → account → credential ref chain
- `createSendEmailTool(department)` — sales/comms/jobhunt get correct Gmail identity
- Backward compatible: empty DB → convention defaults; legacy `LINKEDIN_ACCESS_TOKEN` maps to turicks

## Centralization contract (what to touch when)

| Change | Files to touch | Avoid |
|--------|----------------|-------|
| New account identity (`account_key`) | `src/core/accounts.ts` (`ACCOUNT_KEYS` + `ACCOUNT_SEED_SPECS`) → `pnpm accounts:seed` | Duplicating platform lists in scripts |
| New department → account routing | `src/core/accounts.ts` (`DEPARTMENT_ACCOUNT_DEFAULTS`) only | Prompt instructions |
| New email-sending department | `DEPARTMENT_ACCOUNT_DEFAULTS` + `capabilities.ts` one `createSendEmailTool("dept")` line | Per-tool env hacks |
| Rotate a secret | `.env` or gws profile dir only | Code change |
| New platform (e.g. Slack) | `src/infra/providers/{platform}.ts` + `providers/index.ts` dispatch + tool (ADR-029 map) | Composio unless spike |
| Phase E SaaS | Swap `credential_refs` to Nango IDs in DB | Department/prompt changes |

**Choke points (only these resolve accounts):**
1. `src/core/accounts.ts` — routing + seed specs
2. `src/infra/account-registry.ts` — `resolveAccountContext()`
3. `src/infra/credential-resolver.ts` — env/profile lookup
4. `src/infra/providers/*` — transport only

**Known gaps (not yet registry-backed):** GitHub tool reads `GITHUB_TOKEN` directly (engineering always turicks); boot probes check global turicks creds only. Use `pnpm accounts:status` for per-account health.

## References

- `docs/guides/ACCOUNT-REGISTRY-RUNBOOK.md` — full manual setup steps
- `src/core/accounts.ts` — routing table
- ADR-029, ADR-006 (Phase E → Nango)
