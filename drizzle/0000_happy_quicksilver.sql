CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"action" text NOT NULL,
	"idempotency_key" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "audit_log_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "dept_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"from_dept" text NOT NULL,
	"to_dept" text,
	"event_type" text NOT NULL,
	"payload" jsonb,
	"thread_id" text,
	"consumed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "interrupt_registry" (
	"interrupt_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" text NOT NULL,
	"tenant_id" text DEFAULT 'turicks' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"telegram_msg_id" bigint,
	"callback_data" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"resolved_at" timestamp with time zone,
	"rejection_reason" text,
	"edits" text
);
--> statement-breakpoint
CREATE TABLE "lead_pipeline" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"company_url" text NOT NULL,
	"company_name" text,
	"stage" text DEFAULT 'researching' NOT NULL,
	"icp_score" numeric(4, 3),
	"icp_rationale" text,
	"outreach_tier" text,
	"email_thread_id" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "llm_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"agent" text NOT NULL,
	"tier" text NOT NULL,
	"model" text NOT NULL,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"cost_usd" numeric(10, 6) NOT NULL,
	"lead_id" uuid,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "suppression_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"email_or_domain" text NOT NULL,
	"reason" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "suppression_list_email_or_domain_unique" UNIQUE("email_or_domain")
);
--> statement-breakpoint
CREATE TABLE "task_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"lead_id" uuid,
	"outcome" text NOT NULL,
	"decision_summary" text,
	"tools_used" jsonb,
	"user_feedback" text,
	"cost_usd" numeric(10, 6),
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "al_idem_idx" ON "audit_log" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "al_tenant_action_idx" ON "audit_log" USING btree ("tenant_id","action");--> statement-breakpoint
CREATE INDEX "de_unconsumed_idx" ON "dept_events" USING btree ("tenant_id","consumed","to_dept");--> statement-breakpoint
CREATE INDEX "ir_thread_status_idx" ON "interrupt_registry" USING btree ("thread_id","status");--> statement-breakpoint
CREATE INDEX "ir_expires_idx" ON "interrupt_registry" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "lp_tenant_stage_idx" ON "lead_pipeline" USING btree ("tenant_id","stage");--> statement-breakpoint
CREATE INDEX "lp_url_idx" ON "lead_pipeline" USING btree ("company_url");--> statement-breakpoint
CREATE INDEX "lc_tenant_date_idx" ON "llm_costs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "lc_agent_idx" ON "llm_costs" USING btree ("agent");--> statement-breakpoint
CREATE INDEX "sl_tenant_email_idx" ON "suppression_list" USING btree ("tenant_id","email_or_domain");--> statement-breakpoint
CREATE INDEX "to_agent_outcome_idx" ON "task_outcomes" USING btree ("agent_id","outcome");--> statement-breakpoint
CREATE INDEX "to_tenant_date_idx" ON "task_outcomes" USING btree ("tenant_id","created_at");