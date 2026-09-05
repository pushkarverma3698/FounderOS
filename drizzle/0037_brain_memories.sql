CREATE TABLE IF NOT EXISTS "brain"."brain_memories" (
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
CREATE INDEX IF NOT EXISTS "bm_tenant_type_idx" ON "brain"."brain_memories" USING btree ("tenant_id","memory_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bm_status_idx" ON "brain"."brain_memories" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bm_project_idx" ON "brain"."brain_memories" USING btree ("project");
