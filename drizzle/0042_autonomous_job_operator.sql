CREATE TABLE IF NOT EXISTS "agents"."application_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"profile_id" text NOT NULL,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	"packet_version" integer DEFAULT 1 NOT NULL,
	"error_details" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"blocked_reason" text,
	"last_step" text,
	"next_attempt_at" timestamp with time zone,
	"lease_id" text,
	"worker_id" text,
	"session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agents"."application_tasks" ADD CONSTRAINT "application_tasks_job_id_job_applications_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job_applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "application_tasks_tenant_id_profile_id_job_id_index" ON "agents"."application_tasks" ("tenant_id","profile_id","job_id");
