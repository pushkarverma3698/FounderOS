# Account Registry — Manual Setup Runbook

> **Purpose:** Connect turicks + personal (+ naggar) accounts across Google, LinkedIn, Instagram, and Facebook.  
> **Architecture:** ADR-036. Secrets in `.env` + gws profile dirs. DB holds routing metadata only.  
> **Time:** ~2–3 hours first time (mostly OAuth clicks). Re-auth is ~5 min per expired token.

---

## Overview

| Layer | What you do | What FounderOS does |
|-------|-------------|---------------------|
| **Secrets** | OAuth once per account per platform; store in `.env` or gws dirs | Never stores raw tokens in Postgres |
| **Registry** | `pnpm accounts:seed` once | Routes departments → correct account |
| **Providers** | Nothing (env flags only) | gws / direct API / future Meta Graph |
| **Rollback** | Keep Composio keys optional | `*_BACKEND=composio` if direct path fails |

### Account identities

| `account_key` | Gmail / Calendar | LinkedIn | Instagram / Facebook | GitHub |
|---------------|------------------|----------|----------------------|--------|
| `turicks` | business inbox | Turicks page/profile | Turicks brand pages | org PAT |
| `personal` | personal inbox | personal profile | personal (optional) | personal PAT |
| `naggar` | retreat inbox | — | Naggar pages | — |

### Department routing (automatic)

| Department | Sends email as | Posts LinkedIn as |
|------------|----------------|-------------------|
| sales, comms, marketing | turicks | turicks (marketing) |
| jobhunt | personal | personal |
| personal | personal | — |

Override anytime: agent passes `account_key: "personal"` on `send_email`.

---

## Phase 0 — Prerequisites

### 0.1 Database migration

```bash
sudo pg_ctlcluster 16 main start   # Cloud VM only — skip if Postgres already up
pnpm run setup                     # applies drizzle migrations incl. integration_accounts
```

Verify:

```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM agents.integration_accounts;"
# 0 rows before seed — that's OK
```

### 0.2 Install gws (Google Workspace CLI)

On **prod VPS** and **local** if you test Gmail locally:

```bash
npm install -g @googleworkspace/cli
gws --version
```

### 0.3 Seed registry rows

```bash
pnpm accounts:seed
```

This writes **metadata + credential ref names** — not secrets. You should see ~13 rows (turicks×5, personal×5, naggar×3).

Check:

```bash
pnpm accounts:status
# 🔴 rows = missing env vars (expected before you complete Phase 1–4)
```

---

## Phase 1 — Google (Gmail + Calendar) per account

Each account gets its own gws profile directory. **Do not share one `gws auth login` across turicks and personal.**

### 1.1 Create profile directories

```bash
mkdir -p ~/.founderos/accounts/turicks/gws
mkdir -p ~/.founderos/accounts/personal/gws
mkdir -p ~/.founderos/accounts/naggar/gws
```

### 1.2 Authenticate turicks Gmail

```bash
export GWS_CONFIG_HOME="$HOME/.founderos/accounts/turicks/gws"
gws auth login
# Sign in with: turicks business Gmail
gws auth status
gws gmail users messages list --params '{"userId":"me","maxResults":1}'
```

### 1.3 Authenticate personal Gmail

```bash
export GWS_CONFIG_HOME="$HOME/.founderos/accounts/personal/gws"
gws auth login
# Sign in with: personal Gmail (job applications)
gws auth status
gws gmail users messages list --params '{"userId":"me","maxResults":1}'
```

### 1.4 Authenticate naggar Gmail (if used)

```bash
export GWS_CONFIG_HOME="$HOME/.founderos/accounts/naggar/gws"
gws auth login
# Sign in with: Naggar retreat Gmail
```

### 1.5 Confirm env defaults (usually no extra .env needed for Google)

Registry already points each account at:

```
~/.founderos/accounts/turicks/gws
~/.founderos/accounts/personal/gws
~/.founderos/accounts/naggar/gws
```

Ensure production `.env`:

```bash
GMAIL_BACKEND=gws
CALENDAR_BACKEND=gws
```

### 1.6 Verify from FounderOS

```bash
# Restart bot after auth
pnpm test tests/unit/core/accounts.test.ts tests/unit/infra/account-registry.test.ts
```

Live check (after bot restart):

- Telegram: `/q comms` → "read my last 3 emails" → should use **turicks** inbox
- Telegram: `/q jobhunt` → "read my inbox" → should use **personal** inbox

---

## Phase 2 — LinkedIn per account

### 2.1 Create LinkedIn Developer Apps

You need **one app per identity** (or one app with multiple redirect URIs — single app is fine for admin use).

1. Go to [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps)
2. Create app (or reuse existing Turicks app)
3. Enable product: **Share on LinkedIn** (Posts API)
4. Add OAuth redirect URL (for manual token capture): `http://localhost:3000/callback` or your chosen URI
5. Note: **Client ID**, **Client Secret**

Repeat for personal profile if posting as yourself for jobhunt.

### 2.2 OAuth — get access token + author URN

**Turicks (legacy env names — still supported):**

```bash
# After OAuth flow, add to .env / GitHub secrets:
LINKEDIN_ACCESS_TOKEN=...
LINKEDIN_AUTHOR_URN=urn:li:person:XXXX   # or urn:li:organization:XXXX
```

**Personal (per-account naming convention):**

```bash
LINKEDIN_ACCESS_TOKEN_PERSONAL=...
LINKEDIN_AUTHOR_URN_PERSONAL=urn:li:person:XXXX
```

To find author URN:

```bash
node --env-file=.env --import tsx/esm scripts/probe-linkedin-author.ts
```

### 2.3 Confirm .env

```bash
LINKEDIN_BACKEND=direct
LINKEDIN_API_VERSION=202405
```

### 2.4 Token refresh (manual until Phase E)

LinkedIn tokens expire (~60 days). Calendar reminder:

- Set phone reminder 50 days after each OAuth
- Re-run OAuth → update `.env` + redeploy secrets
- `pnpm accounts:status` should show 🟢 for linkedin rows

### 2.5 Verify

- `/q marketing` → draft LinkedIn post → HITL approve → posts as **turicks**
- Audit row should include `"account_key": "turicks"`

---

## Phase 3 — Instagram + Facebook (Meta Graph API)

> **Status:** Registry seeded; marketing tools not wired yet. Complete this phase so credentials are ready when tools ship.

### 3.1 Meta Developer setup

1. [Meta for Developers](https://developers.facebook.com/) → Create App → **Business** type
2. Add products: **Facebook Login**, **Instagram Graph API**
3. Connect Facebook Pages + Instagram Business accounts:
   - Turicks Instagram must be a **Business/Creator** account linked to a Facebook Page
   - Same for Naggar if applicable

### 3.2 Get long-lived Page Access Token

Use Graph API Explorer or:

```bash
# Short-lived user token → exchange for long-lived → page token
# Document tokens in .env (NEVER commit):
```

**Turicks:**

```bash
INSTAGRAM_ACCESS_TOKEN_TURICKS=...
META_INSTAGRAM_PAGE_ID_TURICKS=...
META_FACEBOOK_PAGE_ID_TURICKS=...
META_APP_ID_TURICKS=...
```

**Personal (optional):**

```bash
INSTAGRAM_ACCESS_TOKEN_PERSONAL=...
META_INSTAGRAM_PAGE_ID_PERSONAL=...
```

**Naggar:**

```bash
INSTAGRAM_ACCESS_TOKEN_NAGGAR=...
META_INSTAGRAM_PAGE_ID_NAGGAR=...
META_FACEBOOK_PAGE_ID_NAGGAR=...
```

### 3.3 Permissions checklist

| Platform | Scopes needed |
|----------|---------------|
| Instagram post | `instagram_basic`, `instagram_content_publish`, `pages_show_list` |
| Facebook post | `pages_manage_posts`, `pages_read_engagement` |

### 3.4 Verify registry

```bash
pnpm accounts:status
# instagram + facebook rows for turicks/naggar should show 🟢 when env vars set
```

---

## Phase 4 — GitHub (optional per-account PATs)

Default: single `GITHUB_TOKEN` for turicks/engineering.

For personal account separation:

```bash
GITHUB_TOKEN=ghp_...              # turicks / FounderOS (default)
GITHUB_TOKEN_PERSONAL=ghp_...       # personal repos only
```

---

## Phase 5 — Production (Hetzner VPS)

### 5.1 Copy gws profiles to VPS

```bash
# From laptop — example using rsync
rsync -avz ~/.founderos/accounts/ founderos@YOUR_VPS:~/.founderos/accounts/
```

Or re-run `gws auth login` on VPS per account (cleaner).

### 5.2 Set GitHub Actions / deploy secrets

Add to repo secrets (or `PROD_DOTENV`):

| Secret | Account |
|--------|---------|
| `LINKEDIN_ACCESS_TOKEN` | turicks |
| `LINKEDIN_AUTHOR_URN` | turicks |
| `LINKEDIN_ACCESS_TOKEN_PERSONAL` | personal |
| `LINKEDIN_AUTHOR_URN_PERSONAL` | personal |
| Meta vars | per runbook Phase 3 |
| `COMPOSIO_API_KEY` | rollback only (optional) |

### 5.3 Run seed + status on prod

```bash
ssh founderos@YOUR_VPS
cd ~/FounderOS
pnpm run setup
pnpm accounts:seed
pnpm accounts:status
```

### 5.4 Boot smoke

```bash
PROVIDER_SMOKE_AT_BOOT=true pnpm start
# Check /tmp/founderos.log for:
# [boot] gmail=gws/UP calendar=gws/UP linkedin=direct/UP
```

---

## Phase 6 — Composio rollback (emergency only)

If gws or LinkedIn direct fails in prod:

```bash
GMAIL_BACKEND=composio
LINKEDIN_BACKEND=composio
COMPOSIO_API_KEY=...
COMPOSIO_GMAIL_CONN_ID=ca_...        # turicks
COMPOSIO_GMAIL_CONN_ID_PERSONAL=ca_...  # personal
COMPOSIO_LINKEDIN_CONN_ID=ca_...
```

List connections:

```bash
node --env-file=.env --import tsx/esm scripts/list-composio-connections.ts
```

---

## Phase 7 — Ongoing operations

### Weekly

```bash
pnpm accounts:status
```

### When adding a new platform tool

Follow PROGRAMMING-RULES wiring map — provider adapter only:

1. `src/infra/providers/meta-instagram.ts` (example)
2. `src/infra/providers/index.ts` dispatch
3. Tool in `src/tools/`
4. Registry row already exists from seed

### When adding a new brand (`account_key`)

1. Add to `ACCOUNT_KEYS` in `src/core/accounts.ts`
2. Add department routing if needed
3. Re-run `pnpm accounts:seed` (extend seed script)
4. Complete OAuth phases above for new identity

### Phase E (SaaS — future)

Replace env refs with Nango connection IDs in `credential_refs`. Departments unchanged.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Sales email sends from wrong inbox | Department not passed | Check `createSendEmailTool("sales")` in capabilities |
| `gws not ready` on turicks but personal works | Wrong profile dir | Re-auth with correct `GWS_CONFIG_HOME` |
| LinkedIn 401 | Expired token | Re-OAuth, update `.env` |
| `accounts:status` all 🔴 | Seed not run or empty `.env` | `pnpm accounts:seed` + fill env vars |
| Composio works, gws doesn't | Profile not on VPS | rsync `~/.founderos/accounts/` or auth on VPS |

---

## Quick reference — env var naming

| Pattern | Example |
|---------|---------|
| `{PLATFORM}_ACCESS_TOKEN_{ACCOUNT}` | `LINKEDIN_ACCESS_TOKEN_PERSONAL` |
| `{PLATFORM}_AUTHOR_URN_{ACCOUNT}` | `LINKEDIN_AUTHOR_URN_PERSONAL` |
| `GITHUB_TOKEN_{ACCOUNT}` | `GITHUB_TOKEN_PERSONAL` |
| `META_INSTAGRAM_PAGE_ID_{ACCOUNT}` | `META_INSTAGRAM_PAGE_ID_TURICKS` |
| gws profile | `~/.founderos/accounts/{account_key}/gws` |

Legacy turicks vars without suffix still work: `LINKEDIN_ACCESS_TOKEN`, `GITHUB_TOKEN`.

---

## Verification checklist

- [ ] `pnpm run setup` — migration 0008 applied
- [ ] `pnpm accounts:seed` — rows in `agents.integration_accounts`
- [ ] gws auth for turicks + personal (+ naggar)
- [ ] LinkedIn tokens + URNs in `.env`
- [ ] Meta tokens for turicks (+ naggar) when marketing needs them
- [ ] `pnpm accounts:status` — all active accounts 🟢
- [ ] `pnpm test` green
- [ ] Live: comms reads turicks inbox, jobhunt sends from personal
- [ ] `action_log` rows include `account_key` in payload
