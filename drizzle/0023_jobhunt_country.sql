-- Where a job actually is, stored rather than re-guessed.
--
-- THE DEFECT THIS CLOSES (live prod sweep, 2026-08-01). Route classification read
-- the posting's PROSE: `extractRoute` returned "hsm" — meaning "Netherlands,
-- highly skilled migrant" — whenever the ad said "on-site", "hybrid" or
-- "office-based". Not one of those words names a country. So an Indian ad saying
-- "hybrid" was filed as a Dutch role and screened against Dutch immigration law;
-- nine rows from the Indeed IN feed sat in production with a Dutch permit basis.
-- Separately, a Colombian posting whose location could not be read reached rank 2
-- of APPLY TODAY justified by a Dutch partner permit.
--
-- The fetcher always knew. It had queried Indeed IN rather than Indeed NL, and
-- the ATS feed returns a location on every posting. That knowledge was discarded
-- on the way into the screener so the screener could re-derive it from wording —
-- a fact replaced by an inference. These two columns are where the fact now
-- lives, and the brief splits its Netherlands and India sections on `country`
-- rather than on anything parsed at render time.
--
-- NL | IN | other | unknown. `other` and `unknown` are deliberately different
-- values: "this job is in Colombia" narrows the lawful bases to one, while "we
-- could not tell where this job is" is an open question that has to be asked.
-- Collapsing them is how the Bogotá row looked identical to a Dutch one.
--
-- Nullable with no default and no backfill. Every existing row keeps NULL and
-- reads back as `unknown`, which is the truth about them — they were screened by
-- a pipeline that never recorded a country, and inventing one now would assert
-- a market for rows nobody established a market for. Re-running
-- scripts/jobhunt-backfill-gates.ts re-screens the stored bodies in place at $0
-- and fills these in for any row whose location survived.
ALTER TABLE agents.job_applications ADD COLUMN IF NOT EXISTS country text;

-- The feed's own location string, verbatim ("Bengaluru, Karnataka, India").
--
-- Kept alongside the derived country for the same reason `description` is kept:
-- the city list in src/tools/jobhunt/country.ts will gain entries over time, and
-- without the source string every row classified before a city was added is
-- unrecoverable. It is also the evidence behind the country — a derived value
-- with no visible input is one nobody can audit.
ALTER TABLE agents.job_applications ADD COLUMN IF NOT EXISTS location text;

-- The brief's India/Netherlands split, and the "how much supply does each market
-- actually produce" question, both scan by country within a tenant.
CREATE INDEX IF NOT EXISTS ja_country_idx
  ON agents.job_applications (tenant_id, country, salary_status);
