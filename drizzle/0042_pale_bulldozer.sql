CREATE SCHEMA "agents";
--> statement-breakpoint
CREATE SCHEMA "brain";
--> statement-breakpoint
CREATE TABLE "agents"."action_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"action" text NOT NULL,
	"idempotency_key" text,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "action_log_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "agents"."agent_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"agent_id" text,
	"s3_key" text NOT NULL,
	"original_filename" text,
	"asset_type" text,
	"mime_type" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agents"."agent_results" (
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
CREATE TABLE "agents"."ai_call_costs" (
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
CREATE TABLE "agents"."answer_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"status" text NOT NULL,
	"not_evaluated_reason" text,
	"groundedness" integer,
	"relevance" integer,
	"completeness" integer,
	"critique" text,
	"goal" text NOT NULL,
	"reply" text NOT NULL,
	"planned_steps" integer DEFAULT 0 NOT NULL,
	"judge_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."application_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"profile_id" text NOT NULL,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	"packet_version" integer DEFAULT 1 NOT NULL,
	"error_details" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agents"."ats_board_cache" (
	"url" text PRIMARY KEY NOT NULL,
	"etag" text,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain"."brain_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'turicks' NOT NULL,
	"memory_type" text NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(768),
	"source" text,
	"source_id" text,
	"project" text,
	"importance" numeric(4, 3),
	"confidence" numeric(4, 3),
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agents"."conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"tenant_id" text DEFAULT 'turicks' NOT NULL,
	"started_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"summary" text,
	"topics" jsonb DEFAULT '[]'::jsonb,
	"message_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "conversations_thread_id_unique" UNIQUE("thread_id")
);
--> statement-breakpoint
CREATE TABLE "agents"."cv_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"term" text NOT NULL,
	"category" text NOT NULL,
	"track" text DEFAULT 'unclassified' NOT NULL,
	"seen_count" integer DEFAULT 0 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now(),
	"last_seen_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agents"."dept_signals" (
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
CREATE TABLE "agents"."do_not_contact" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"email_or_domain" text NOT NULL,
	"reason" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "do_not_contact_email_or_domain_unique" UNIQUE("email_or_domain")
);
--> statement-breakpoint
CREATE TABLE "agents"."episodic_memory" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text DEFAULT 'turicks' NOT NULL,
	"event_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"thread_id" text,
	"source" text DEFAULT 'telegram' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agents"."evolution_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"location" text,
	"subject" text NOT NULL,
	"analyzer" text NOT NULL,
	"detail" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"times_seen" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"run_id" uuid
);
--> statement-breakpoint
CREATE TABLE "agents"."evolution_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"commit_sha" text,
	"loop" text NOT NULL,
	"findings_count" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"analyzers_run" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."failure_lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"worker" text NOT NULL,
	"signature" text NOT NULL,
	"component" text NOT NULL,
	"objective" text NOT NULL,
	"resolved_with_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"times_seen" integer DEFAULT 1 NOT NULL,
	"times_resolved" integer DEFAULT 0 NOT NULL,
	"times_applied" integer DEFAULT 0 NOT NULL,
	"migrated_from_v1" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"last_resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."founder_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "founder_context_tenant_id_unique" UNIQUE("tenant_id")
);
--> statement-breakpoint
CREATE TABLE "agents"."gap_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'turicks' NOT NULL,
	"target_name" text NOT NULL,
	"target_domain" text NOT NULL,
	"category" text NOT NULL,
	"gap_score" integer NOT NULL,
	"confidence" text DEFAULT 'low' NOT NULL,
	"completion_rate" numeric(4, 3) NOT NULL,
	"runs_total" integer NOT NULL,
	"surfaces" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"report" jsonb NOT NULL,
	"insights" jsonb,
	"markdown" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agents"."hitl_approvals" (
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
CREATE TABLE "agents"."integration_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_key" text NOT NULL,
	"platform" text NOT NULL,
	"display_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"auth_backend" text NOT NULL,
	"credential_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agents"."job_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"profile_id" text DEFAULT 'pushkar-nl-tech' NOT NULL,
	"dedupe_key" text NOT NULL,
	"soft_dedupe_key" text,
	"route" text DEFAULT 'hsm' NOT NULL,
	"company" text NOT NULL,
	"registered_name" text,
	"title" text NOT NULL,
	"url" text,
	"sponsor_verdict" text NOT NULL,
	"salary_status" text NOT NULL,
	"salary_evidence" text,
	"gate_json" text,
	"fit_score" numeric,
	"fit_evidence" text,
	"stage" text DEFAULT 'screened' NOT NULL,
	"applied_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"last_contact_at" timestamp with time zone,
	"followups_sent" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"description" text,
	"posted_at" timestamp with time zone,
	"source" text DEFAULT 'manual' NOT NULL,
	"track" text DEFAULT 'unclassified' NOT NULL,
	"country" text,
	"location" text,
	"external_id" text,
	"liveness" text DEFAULT 'unknown' NOT NULL,
	"liveness_checked_at" timestamp with time zone,
	"brief_section" text,
	"brief_rank" integer,
	"tailor_status" text,
	"tailor_note" text,
	"tailored_cv_s3_key" text,
	"tailored_docx_s3_key" text,
	"cover_letter_s3_key" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agents"."job_ingest_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"sweep_id" uuid NOT NULL,
	"feed" text NOT NULL,
	"pool" text NOT NULL,
	"track" text NOT NULL,
	"requested" integer NOT NULL,
	"returned" integer DEFAULT 0 NOT NULL,
	"screened" integer DEFAULT 0 NOT NULL,
	"passed" integer DEFAULT 0 NOT NULL,
	"flagged" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"duplicates" integer DEFAULT 0 NOT NULL,
	"errored" integer DEFAULT 0 NOT NULL,
	"screen_error" text,
	"fresh" integer DEFAULT 0 NOT NULL,
	"seen" integer,
	"undated" integer,
	"stale" integer,
	"off_track" integer,
	"off_market" integer,
	"known" integer,
	"bodyless" integer,
	"estimated_cost_usd" numeric DEFAULT '0' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agents"."job_lane_heartbeats" (
	"profile_id" text PRIMARY KEY NOT NULL,
	"quiet_sweeps" integer DEFAULT 0 NOT NULL,
	"boards_polled" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"zero_pass_streak" integer DEFAULT 0 NOT NULL,
	"last_funnel" jsonb,
	"fresh_viewed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain"."knowledge_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'turicks' NOT NULL,
	"entry_type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"source" text,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"embedding" vector(768),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agents"."missions" (
	"mission_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'turicks' NOT NULL,
	"session_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"owner" text DEFAULT 'founder' NOT NULL,
	"issue_ref" text,
	"goal" text NOT NULL,
	"scope" text,
	"completion_criteria" text,
	"risk" text DEFAULT 'low',
	"phase" text DEFAULT 'INIT' NOT NULL,
	"department" text,
	"next_action" text,
	"agent_statuses" jsonb DEFAULT '{}'::jsonb,
	"telegram_msg_id" bigint,
	"turn_id" uuid,
	"started_at" timestamp with time zone DEFAULT now(),
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agents"."outbound_leads" (
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
CREATE TABLE "brain"."personal_rag" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"embedding" vector(768),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agents"."reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"text" text NOT NULL,
	"remind_at" timestamp with time zone NOT NULL,
	"recurrence" jsonb,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"idempotency_key" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"fired_at" timestamp with time zone,
	CONSTRAINT "reminders_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "brain"."research_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"embedding" vector(768),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "agents"."saved_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"slug" text NOT NULL,
	"signature" text NOT NULL,
	"tool" text NOT NULL,
	"command" text NOT NULL,
	"brief" text,
	"image" text,
	"s3_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_run_id" text,
	"run_count" integer DEFAULT 1 NOT NULL,
	"first_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents"."scheduled_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"platform" text NOT NULL,
	"account_key" text NOT NULL,
	"text" text NOT NULL,
	"mention_urn" text,
	"mention_name" text,
	"visibility" text DEFAULT 'PUBLIC' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"idempotency_key" text NOT NULL,
	"post_id" text,
	"post_url" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"posted_at" timestamp with time zone,
	CONSTRAINT "scheduled_posts_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "agents"."scheduled_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"prompt" text NOT NULL,
	"chat_id" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"error" text,
	"recurrence" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"completed_at" timestamp with time zone,
	CONSTRAINT "scheduled_tasks_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "brain"."turicks_brain" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"embedding" vector(768),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
DROP TABLE "audit_log" CASCADE;--> statement-breakpoint
DROP TABLE "dept_events" CASCADE;--> statement-breakpoint
DROP TABLE "interrupt_registry" CASCADE;--> statement-breakpoint
DROP TABLE "lead_pipeline" CASCADE;--> statement-breakpoint
DROP TABLE "llm_costs" CASCADE;--> statement-breakpoint
DROP TABLE "suppression_list" CASCADE;--> statement-breakpoint
DROP TABLE "task_outcomes" CASCADE;--> statement-breakpoint
ALTER TABLE "agents"."application_tasks" ADD CONSTRAINT "application_tasks_job_id_job_applications_id_fk" FOREIGN KEY ("job_id") REFERENCES "agents"."job_applications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents"."evolution_findings" ADD CONSTRAINT "evolution_findings_run_id_evolution_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "agents"."evolution_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "al_idem_idx" ON "agents"."action_log" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "al_tenant_action_idx" ON "agents"."action_log" USING btree ("tenant_id","action");--> statement-breakpoint
CREATE INDEX "aa_run_idx" ON "agents"."agent_assets" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "aa_type_idx" ON "agents"."agent_assets" USING btree ("asset_type");--> statement-breakpoint
CREATE INDEX "ar_agent_outcome_idx" ON "agents"."agent_results" USING btree ("agent_id","outcome");--> statement-breakpoint
CREATE INDEX "ar_tenant_date_idx" ON "agents"."agent_results" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "acc_tenant_date_idx" ON "agents"."ai_call_costs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "acc_agent_idx" ON "agents"."ai_call_costs" USING btree ("agent");--> statement-breakpoint
CREATE INDEX "ae_tenant_created_idx" ON "agents"."answer_evaluations" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "ae_tenant_status_idx" ON "agents"."answer_evaluations" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "ae_turn_idx" ON "agents"."answer_evaluations" USING btree ("turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "at_dedupe_uniq" ON "agents"."application_tasks" USING btree ("tenant_id","profile_id","job_id");--> statement-breakpoint
CREATE INDEX "at_queue_idx" ON "agents"."application_tasks" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "bm_tenant_type_idx" ON "brain"."brain_memories" USING btree ("tenant_id","memory_type");--> statement-breakpoint
CREATE INDEX "bm_status_idx" ON "brain"."brain_memories" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bm_project_idx" ON "brain"."brain_memories" USING btree ("project");--> statement-breakpoint
CREATE INDEX "conv_tenant_time_idx" ON "agents"."conversations" USING btree ("tenant_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cv_signals_track_term_uniq" ON "agents"."cv_signals" USING btree ("tenant_id","track","term");--> statement-breakpoint
CREATE INDEX "cv_signals_track_rank_idx" ON "agents"."cv_signals" USING btree ("tenant_id","track","seen_count");--> statement-breakpoint
CREATE INDEX "ds_unconsumed_idx" ON "agents"."dept_signals" USING btree ("tenant_id","consumed","to_dept");--> statement-breakpoint
CREATE INDEX "dnc_tenant_email_idx" ON "agents"."do_not_contact" USING btree ("tenant_id","email_or_domain");--> statement-breakpoint
CREATE INDEX "em_tenant_time_idx" ON "agents"."episodic_memory" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "em_title_idx" ON "agents"."episodic_memory" USING btree ("title");--> statement-breakpoint
CREATE UNIQUE INDEX "ef_tenant_fingerprint_idx" ON "agents"."evolution_findings" USING btree ("tenant_id","fingerprint");--> statement-breakpoint
CREATE INDEX "ef_tenant_analyzer_idx" ON "agents"."evolution_findings" USING btree ("tenant_id","analyzer","status");--> statement-breakpoint
CREATE UNIQUE INDEX "fl_tenant_worker_sig_idx" ON "agents"."failure_lessons" USING btree ("tenant_id","worker","signature");--> statement-breakpoint
CREATE INDEX "gs_domain_time_idx" ON "agents"."gap_scans" USING btree ("tenant_id","target_domain","created_at");--> statement-breakpoint
CREATE INDEX "gs_category_idx" ON "agents"."gap_scans" USING btree ("tenant_id","category");--> statement-breakpoint
CREATE INDEX "ha_thread_status_idx" ON "agents"."hitl_approvals" USING btree ("thread_id","status");--> statement-breakpoint
CREATE INDEX "ha_expires_idx" ON "agents"."hitl_approvals" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "ia_account_platform_idx" ON "agents"."integration_accounts" USING btree ("account_key","platform");--> statement-breakpoint
CREATE INDEX "ia_status_idx" ON "agents"."integration_accounts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "ja_dedupe_uniq" ON "agents"."job_applications" USING btree ("tenant_id","profile_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "ja_stage_idx" ON "agents"."job_applications" USING btree ("tenant_id","stage","last_contact_at");--> statement-breakpoint
CREATE INDEX "ja_track_verdict_idx" ON "agents"."job_applications" USING btree ("tenant_id","track","salary_status");--> statement-breakpoint
CREATE INDEX "ja_apply_queue_idx" ON "agents"."job_applications" USING btree ("tenant_id","applied_at","brief_rank");--> statement-breakpoint
CREATE INDEX "ja_profile_idx" ON "agents"."job_applications" USING btree ("tenant_id","profile_id","brief_section","brief_rank");--> statement-breakpoint
CREATE INDEX "jir_tenant_day_idx" ON "agents"."job_ingest_runs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "jir_sweep_idx" ON "agents"."job_ingest_runs" USING btree ("sweep_id");--> statement-breakpoint
CREATE INDEX "ke_type_idx" ON "brain"."knowledge_entries" USING btree ("tenant_id","entry_type","is_current");--> statement-breakpoint
CREATE INDEX "ke_title_idx" ON "brain"."knowledge_entries" USING btree ("title");--> statement-breakpoint
CREATE INDEX "missions_session_active_idx" ON "agents"."missions" USING btree ("session_id","phase");--> statement-breakpoint
CREATE INDEX "missions_tenant_idx" ON "agents"."missions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "ol_tenant_stage_idx" ON "agents"."outbound_leads" USING btree ("tenant_id","stage");--> statement-breakpoint
CREATE INDEX "ol_url_idx" ON "agents"."outbound_leads" USING btree ("company_url");--> statement-breakpoint
CREATE INDEX "rem_due_idx" ON "agents"."reminders" USING btree ("status","remind_at");--> statement-breakpoint
CREATE INDEX "rem_tenant_idx" ON "agents"."reminders" USING btree ("tenant_id","remind_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sw_tenant_sig_idx" ON "agents"."saved_workflows" USING btree ("tenant_id","signature");--> statement-breakpoint
CREATE INDEX "sw_popularity_idx" ON "agents"."saved_workflows" USING btree ("tenant_id","run_count");--> statement-breakpoint
CREATE INDEX "sp_due_idx" ON "agents"."scheduled_posts" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "sp_tenant_idx" ON "agents"."scheduled_posts" USING btree ("tenant_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "st_due_idx" ON "agents"."scheduled_tasks" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "st_tenant_idx" ON "agents"."scheduled_tasks" USING btree ("tenant_id","scheduled_at");