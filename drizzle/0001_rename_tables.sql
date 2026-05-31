-- FounderOS — Migration 0001: Rename tables to clearer names
-- Applied by drizzle-kit migrate (registered in meta/_journal.json).
-- IF EXISTS guards make it safe to run against partially-migrated databases.
--
-- Rename map:
--   interrupt_registry → hitl_approvals
--   llm_costs          → ai_call_costs
--   audit_log          → action_log
--   lead_pipeline      → outbound_leads
--   suppression_list   → do_not_contact
--   task_outcomes      → agent_results
--   dept_events        → dept_signals
ALTER TABLE IF EXISTS "interrupt_registry" RENAME TO "hitl_approvals";--> statement-breakpoint
ALTER TABLE IF EXISTS "llm_costs" RENAME TO "ai_call_costs";--> statement-breakpoint
ALTER TABLE IF EXISTS "audit_log" RENAME TO "action_log";--> statement-breakpoint
ALTER TABLE IF EXISTS "lead_pipeline" RENAME TO "outbound_leads";--> statement-breakpoint
ALTER TABLE IF EXISTS "suppression_list" RENAME TO "do_not_contact";--> statement-breakpoint
ALTER TABLE IF EXISTS "task_outcomes" RENAME TO "agent_results";--> statement-breakpoint
ALTER TABLE IF EXISTS "dept_events" RENAME TO "dept_signals";--> statement-breakpoint
ALTER INDEX IF EXISTS "ir_thread_status_idx" RENAME TO "ha_thread_status_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "ir_expires_idx" RENAME TO "ha_expires_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "lc_tenant_date_idx" RENAME TO "acc_tenant_date_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "lc_agent_idx" RENAME TO "acc_agent_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "lp_tenant_stage_idx" RENAME TO "ol_tenant_stage_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "lp_url_idx" RENAME TO "ol_url_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "sl_tenant_email_idx" RENAME TO "dnc_tenant_email_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "to_agent_outcome_idx" RENAME TO "ar_agent_outcome_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "to_tenant_date_idx" RENAME TO "ar_tenant_date_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "de_unconsumed_idx" RENAME TO "ds_unconsumed_idx";
