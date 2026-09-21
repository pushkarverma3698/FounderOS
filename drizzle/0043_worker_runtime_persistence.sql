CREATE TABLE IF NOT EXISTS "agents"."worker_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'turicks' NOT NULL,
	"worker_id" text NOT NULL,
	"contract_version" text NOT NULL,
	"contract" jsonb NOT NULL,
	"is_active" text DEFAULT 'true' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wc_worker_version_idx" ON "agents"."worker_contracts" ("worker_id","contract_version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wc_active_idx" ON "agents"."worker_contracts" ("worker_id","is_active");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents"."worker_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'turicks' NOT NULL,
	"worker_id" text NOT NULL,
	"status" text DEFAULT 'CREATED' NOT NULL,
	"contract_version" text NOT NULL,
	"runtime_provider" text,
	"runtime_id" text,
	"failure_reason" text,
	"recovery_attempts" text DEFAULT '0' NOT NULL,
	"last_transition" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ws_worker_idx" ON "agents"."worker_state" ("worker_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ws_status_idx" ON "agents"."worker_state" ("status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents"."worker_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'turicks' NOT NULL,
	"worker_id" text NOT NULL,
	"session_id" text NOT NULL UNIQUE,
	"runtime_provider" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now(),
	"ended_at" timestamp with time zone,
	"last_heartbeat" timestamp with time zone DEFAULT now(),
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "w_sess_worker_idx" ON "agents"."worker_sessions" ("worker_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "w_sess_session_id_idx" ON "agents"."worker_sessions" ("session_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents"."worker_objectives" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'turicks' NOT NULL,
	"worker_id" text NOT NULL,
	"objective_id" text NOT NULL,
	"description" text NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"mission_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wo_worker_idx" ON "agents"."worker_objectives" ("worker_id","status");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents"."worker_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'turicks' NOT NULL,
	"worker_id" text NOT NULL,
	"mission_id" uuid,
	"task_id" text,
	"status" text NOT NULL,
	"summary" text NOT NULL,
	"blockers" jsonb,
	"next_action" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wp_worker_time_idx" ON "agents"."worker_progress" ("worker_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wp_mission_idx" ON "agents"."worker_progress" ("mission_id");
