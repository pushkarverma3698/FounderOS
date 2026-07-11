-- FounderOS — Migration 0011: gap_scans table
-- AI Visibility Gap Scanner persistence (lead-acquisition spec Layer 1 + §11).
-- One row per finished scan: hot columns for indexed lookup, full report +
-- insights as JSONB so scans can be re-rendered without rerunning paid calls.

CREATE TABLE IF NOT EXISTS agents.gap_scans (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT        NOT NULL DEFAULT 'turicks',
  target_name     TEXT        NOT NULL,
  target_domain   TEXT        NOT NULL,     -- normalized bare domain (natural key)
  category        TEXT        NOT NULL,
  gap_score       INTEGER     NOT NULL,     -- 0-100 weighted gap vs best competitor
  confidence      TEXT        NOT NULL DEFAULT 'low',  -- high | medium | low
  completion_rate NUMERIC(4,3) NOT NULL,
  runs_total      INTEGER     NOT NULL,
  surfaces        JSONB       NOT NULL DEFAULT '[]',
  report          JSONB       NOT NULL,     -- full GapReportData
  insights        JSONB,                    -- GapInsights (funnel/threats/volatility/confidence)
  markdown        TEXT        NOT NULL,     -- rendered 1-page gap report
  created_at      TIMESTAMPTZ DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS gs_domain_time_idx ON agents.gap_scans (tenant_id, target_domain, created_at);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS gs_category_idx    ON agents.gap_scans (tenant_id, category);
