-- Reverses 0032_private_group_chat_messages.
--
-- The table shipped with six query helpers in src/db/private-group-chat-queries.ts
-- and ZERO callers: nothing in src/, tests/ or scripts/ ever wrote a row, so the
-- table was dead weight in every environment that ran 0032 (prod included).
-- Founder decision 2026-08-20: remove the path rather than wire it.
--
-- 0032 is deliberately left in the journal. It really did run on prod, and a
-- migration that has been applied is append-only history — the correction is a
-- new migration, not a rewrite of the old one. A fresh database therefore
-- creates the table and immediately drops it, which is harmless.
DROP INDEX IF EXISTS agents.pgcm_timestamp_idx;

DROP INDEX IF EXISTS agents.pgcm_username_idx;

DROP TABLE IF EXISTS agents.private_group_chat_messages;
