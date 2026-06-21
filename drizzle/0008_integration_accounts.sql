-- ADR-036: Integration account registry (metadata + credential refs, not raw secrets)

CREATE TABLE IF NOT EXISTS agents.integration_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_key text NOT NULL,
  platform text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  auth_backend text NOT NULL,
  credential_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT integration_accounts_account_platform_unique UNIQUE (account_key, platform)
);

CREATE INDEX IF NOT EXISTS ia_account_platform_idx
  ON agents.integration_accounts (account_key, platform);

CREATE INDEX IF NOT EXISTS ia_status_idx
  ON agents.integration_accounts (status);
