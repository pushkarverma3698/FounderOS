-- Phase C: Founder context table
-- Live business state for the founder — one row per tenant.
-- Agents read this at session start to understand current priorities.
CREATE TABLE IF NOT EXISTS "founder_context" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"data" jsonb DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "founder_context_tenant_id_unique" UNIQUE("tenant_id")
);
