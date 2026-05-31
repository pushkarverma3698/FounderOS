# ADR-006: Auth Strategy — Composio Internal + Google OAuth SaaS

**Date**: 2026-06-01
**Status**: Accepted

## Context

FounderOS needs to authenticate with multiple external platforms (LinkedIn, Instagram, GitHub, Gmail). As FounderOS moves from personal tool to multi-tenant SaaS, the auth architecture must support both use cases without a full rewrite.

## Decision

### Internal (Phase 1-2)
- **Composio** manages all platform OAuth tokens
- Single Composio account connected to all platforms
- FounderOS calls Composio tools; Composio handles token refresh

### Multi-Tenant SaaS (Phase 3+)
- **User login**: Google OAuth (Gmail sign-in) — lowest friction, no password management
- **Platform connections**: Each tenant connects their own Composio account
- **AI API access**: User provides one API key → encrypted at rest in turicks-brain
- **Tenant isolation**: `TenantAwareCheckpointer` (already implemented in `src/infra/checkpointer.ts`) handles thread-level isolation

## Rationale

- Composio already used internally → zero new integration cost for current phase
- Google OAuth is industry standard for B2B SaaS — reduces sign-up friction
- Single API key model keeps complexity low; avoids per-provider key management for users
- Tenant isolation is already built into the checkpointer — no architectural changes needed for multi-tenancy

## Consequences

- Users must create a Composio account for platform connections (acceptable friction for power users)
- If Composio changes pricing/API, platform connections break — mitigate by abstracting behind `UnifiedTool` interface
- Google OAuth requires a verified Google Cloud project for production
