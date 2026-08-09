-- job_applications tailoring columns — present in prod, absent from the corpus.
-- Added to src/db/schema.ts on 2026-08-06 (c2876e7, resume-tailoring engine)
-- with no migration, then applied to the production database out of band. Prod
-- has them; a database provisioned from `pnpm db:migrate` alone does NOT, so any
-- fresh environment (rebuild, restore, second tenant) breaks every job_applications
-- .select()/.returning() the moment it boots.
-- IF NOT EXISTS keeps this a no-op on the box that already carries them.
-- All nullable text, matching both the schema declaration and the live prod types.

ALTER TABLE agents.job_applications
  ADD COLUMN IF NOT EXISTS tailor_status text,
  ADD COLUMN IF NOT EXISTS tailored_cv_s3_key text,
  ADD COLUMN IF NOT EXISTS tailored_docx_s3_key text,
  ADD COLUMN IF NOT EXISTS cover_letter_s3_key text;
