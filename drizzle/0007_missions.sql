CREATE TABLE IF NOT EXISTS "agents"."missions" (
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

CREATE INDEX IF NOT EXISTS "missions_session_active_idx" ON "agents"."missions" ("session_id", "phase");
CREATE INDEX IF NOT EXISTS "missions_tenant_idx" ON "agents"."missions" ("tenant_id", "created_at");
