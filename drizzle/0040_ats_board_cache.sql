-- ats_board_cache: persistent board metadata and conditional GET cache.
--
-- Survives process restarts so the free-board sweep doesn't unconditionally
-- re-fetch ~1,300 boards on boot. Tracks ETag, Last-Modified, payload, HTTP status,
-- and failure count per board URL.

CREATE TABLE IF NOT EXISTS "agents"."ats_board_cache" (
	"url" text PRIMARY KEY NOT NULL,
	"etag" text,
	"last_modified" text,
	"payload_hash" text,
	"payload" text,
	"status" integer,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
