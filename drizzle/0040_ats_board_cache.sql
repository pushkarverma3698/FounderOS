CREATE TABLE IF NOT EXISTS "agents"."ats_board_cache" (
	"url" text PRIMARY KEY NOT NULL,
	"etag" text,
	"payload" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
