-- FounderOS — Migration 0001: Rename tables to clearer names
-- Run: npx drizzle-kit migrate  (or psql -f this file)
--
-- Rename map:
--   interrupt_registry → hitl_approvals
--   llm_costs          → ai_call_costs
--   audit_log          → action_log
--   lead_pipeline      → outbound_leads
--   suppression_list   → do_not_contact
--   task_outcomes      → agent_results
--   dept_events        → dept_signals

ALTER TABLE "interrupt_registry" RENAME TO "hitl_approvals";
ALTER TABLE "llm_costs"          RENAME TO "ai_call_costs";
ALTER TABLE "audit_log"          RENAME TO "action_log";
ALTER TABLE "lead_pipeline"      RENAME TO "outbound_leads";
ALTER TABLE "suppression_list"   RENAME TO "do_not_contact";
ALTER TABLE "task_outcomes"      RENAME TO "agent_results";
ALTER TABLE "dept_events"        RENAME TO "dept_signals";

-- Rename indexes to match new prefixes
ALTER INDEX IF EXISTS "ir_thread_status_idx" RENAME TO "ha_thread_status_idx";
ALTER INDEX IF EXISTS "ir_expires_idx"       RENAME TO "ha_expires_idx";
ALTER INDEX IF EXISTS "lc_tenant_date_idx"   RENAME TO "acc_tenant_date_idx";
ALTER INDEX IF EXISTS "lc_agent_idx"         RENAME TO "acc_agent_idx";
ALTER INDEX IF EXISTS "lp_tenant_stage_idx"  RENAME TO "ol_tenant_stage_idx";
ALTER INDEX IF EXISTS "lp_url_idx"           RENAME TO "ol_url_idx";
ALTER INDEX IF EXISTS "sl_tenant_email_idx"  RENAME TO "dnc_tenant_email_idx";
ALTER INDEX IF EXISTS "to_agent_outcome_idx" RENAME TO "ar_agent_outcome_idx";
ALTER INDEX IF EXISTS "to_tenant_date_idx"   RENAME TO "ar_tenant_date_idx";
ALTER INDEX IF EXISTS "de_unconsumed_idx"    RENAME TO "ds_unconsumed_idx";
