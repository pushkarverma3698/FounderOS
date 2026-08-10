-- scheduled_tasks.recurrence — declared, never migrated.
-- Added to src/db/schema.ts on 2026-07-29 (c53f6a6) with no accompanying
-- migration. Every drizzle query on this table that emits an explicit column
-- list (.select() / .returning()) therefore died in production with
-- `column "recurrence" does not exist`: insertScheduledTask,
-- listUpcomingScheduledTasks, cancelScheduledTask, rescheduleScheduledTask and
-- reclaimStrandedScheduledTasks — i.e. schedule_task, list_scheduled,
-- edit_scheduled and boot-time stranded-task recovery were dead from 2026-07-29
-- to 2026-08-10, while the unit suite stayed green against mock-db.
-- Nullable: NULL means a one-shot task (see the schema docblock).

ALTER TABLE agents.scheduled_tasks
  ADD COLUMN IF NOT EXISTS recurrence text;
