-- private_group_chat_messages (src/db/schema.ts, src/db/private-group-chat-queries.ts).
--
-- Persistent store for private group chat messages sent through the gateway.
-- One row per message. `metadata` carries any gateway-specific envelope fields
-- (chat_id, platform, message_id, etc.) without requiring schema changes per
-- integration. Written best-effort by the gateway after a message is received;
-- a write failure must never block message processing.
--
-- Indexes:
--   pgcm_username_idx  — look up all messages from a given user
--   pgcm_timestamp_idx — time-ordered retrieval and range queries
CREATE TABLE IF NOT EXISTS agents.private_group_chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Sender's username or handle as reported by the gateway.
  username text NOT NULL,

  -- Full message text.
  message text NOT NULL,

  -- When the message was sent (gateway-provided, not insert time).
  timestamp timestamptz NOT NULL DEFAULT now(),

  -- Arbitrary gateway envelope fields: chat_id, platform, message_id, etc.
  metadata jsonb DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS pgcm_username_idx
  ON agents.private_group_chat_messages (username);

CREATE INDEX IF NOT EXISTS pgcm_timestamp_idx
  ON agents.private_group_chat_messages (timestamp);
