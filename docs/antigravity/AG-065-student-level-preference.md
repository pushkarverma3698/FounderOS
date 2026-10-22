# AG-065: career level is a profile preference, so student roles can pass

Founder request 2026-10-22: "how can i make this product as a SAAS ... Our main targets is student's".
Plan: [docs/plans/2026-10-22-job-search-saas-plan.md](../plans/2026-10-22-job-search-saas-plan.md) §3.3 item 1.

Depth: **Lite** (a pure gate and a profile field; no money, auth, schema or prod data). Base: `beta`.
`src/tools/jobhunt/` is frozen until 2026-11-01: the PR needs the `unfreeze` label and a `Moves:` line.
Read [STANDARDS.md](STANDARDS.md) before editing.

## Goal

Today every internship, graduate-scheme, working-student and apprenticeship title is rejected by the
Experience gate (`src/tools/jobhunt/experience.ts:221`, via `isEarlyCareerTitle` in `seniority.ts`). That is
right for the two current profiles and wrong for a student. After this change a profile lists which early-career
kinds it accepts. An accepted kind goes on to the normal years check. The two current profiles accept none, so
their behaviour and evidence text stay byte-identical.

## Files in scope

1. `src/tools/jobhunt/seniority.ts`
   - Export `EARLY_CAREER_KINDS = ["internship", "graduate", "working-student", "apprenticeship"] as const` and
     `type EarlyCareerKind`.
   - Export `earlyCareerKind(title: string): EarlyCareerKind | null`. Map every term already in
     `EARLY_CAREER_TERMS`, and add none:
     - internship: intern, internship, interns, stage, stagiair, stagiaire, placement, praktikant, praktikum
     - graduate: graduate, grad, starter, trainee, traineeship, and the existing cohort-year + programme rule
     - working-student: student, werkstudent, werkstudentin
     - apprenticeship: apprentice, apprenticeship
   - When a title carries terms of two kinds ("Graduate Intern"), return the first in the order internship,
     working-student, apprenticeship, graduate. The test pins this order.
   - `isEarlyCareerTitle(title)` becomes `earlyCareerKind(title) !== null`. Its existing tests must pass
     unchanged.
2. `src/tools/jobhunt/profile-config.ts`
   - Add `earlyCareerKinds: z.array(z.enum(EARLY_CAREER_KINDS)).default([])` to `JobSearchProfileSchema`, with a
     doc comment in the style of `maxTitlePass`. Importing from `seniority.ts` is safe: it imports nothing.
   - Set `earlyCareerKinds: []` explicitly on `PUSHKAR_PROFILE`. `JobSearchProfile` is `z.infer`, so a
     defaulted field is still required on the literal, as `maxTitlePass` is.
3. `src/tools/jobhunt/profiles/wife-nl-finance.ts`: set `earlyCareerKinds: []` on `WIFE_FINANCE_PROFILE`.
4. `src/tools/jobhunt/experience.ts` (`experienceGate`):
   - `kind = earlyCareerKind(title)`.
   - `kind !== null` and `profile.earlyCareerKinds.length === 0`: return today's reject, same evidence string.
   - `kind !== null` and the profile accepts some kinds but not this one: reject with
     `"<title>" is a <kind> role, and this profile accepts only <list> roles.`
   - `kind` is accepted: do not return; fall through to the existing years logic unchanged.
   - Update the function's doc comment (the "an internship or graduate scheme → reject" bullet) to match.

## Pattern to follow

`maxTitlePass` / `maxTitleStretch` in `profile-config.ts` and their reader in `level.ts`: a property of the
profile, defaulted to today's behaviour, read by a pure gate.

## Explicitly forbidden

- Changing `EARLY_CAREER_TERMS`, `SOURCE_EXCLUDED_TITLE_TERMS`, `ats-source.ts` or `indeed-source.ts`. The paid
  Apify and Indeed lanes are dormant and no student profile uses them in Phase 1.
- Changing Tashi's `rejectTitleTerms` in `wife-nl-finance-terms.ts`. They drop her working-student and `stage`
  titles at classify time on purpose.
- Adding a student profile to `registerProfile`, the bot, the menu or the Mini App. Profiles from the database are
  Phase 1, built by Claude.
- Any change to `level.ts`, the years thresholds or any other gate.

## Tests first

Write these, watch them fail, then implement.

1. `tests/unit/jobhunt/seniority.test.ts`: `earlyCareerKind` returns the kind for every term listed above, null for
   "Internal Tools Engineer", "International Sales Manager" and "Engineer, Payments 2026 Team", "graduate" for
   "Graduate Programme 2027", and "internship" for "Graduate Intern".
2. `tests/unit/jobhunt/experience.test.ts`:
   - Both registered profiles: `getProfile("pushkar-nl-tech").earlyCareerKinds` and
     `getProfile("wife-nl-finance").earlyCareerKinds` equal `[]`.
   - Both profiles: "Software Engineer Intern" and "Graduate Software Engineer (2027)" reject with the same
     evidence string as before. Copy the exact string from the current code into the test.
   - A test profile `{ ...getProfile(), earlyCareerKinds: ["internship"], maxYearsDemanded: 1, maxYearsStretch: 2 }`:
     "Software Engineer Intern" with a body that states no years passes; with "5+ years of experience" it rejects
     on years, not on level; "Graduate Software Engineer (2027)" rejects with the new "accepts only internship"
     text.

## Verify command (report raw output)

```bash
pnpm vitest run tests/unit/jobhunt/seniority.test.ts tests/unit/jobhunt/experience.test.ts > /tmp/ag065-unit-$$.log 2>&1; echo "exit=$?"; tail -20 /tmp/ag065-unit-$$.log
pnpm gate > /tmp/ag065-gate-$$.log 2>&1; echo "exit=$?"; tail -30 /tmp/ag065-gate-$$.log
```

## Live proof ($0, real titles)

`scripts/diagnose-free-funnel.ts` does not run the Experience gate, so it cannot prove this. Instead, with a
throwaway script outside the repo (do not commit it):

1. On `beta`: sweep the first 200 boards (`sweepBoards(getFreeBoards().slice(0, 200))` from
   `free-ats-source.ts`), save every title to `/tmp/ag065-titles.json`, then save
   `experienceGate("", title, getProfile(id))` status and evidence for both profile ids to `/tmp/ag065-before.json`.
2. On the branch: read the same `/tmp/ag065-titles.json` (no new sweep) and write `/tmp/ag065-after.json`.
3. Show `diff /tmp/ag065-before.json /tmp/ag065-after.json; echo "exit=$?"`. It must print nothing and exit 0.
4. Print how many of those titles a profile with all four kinds would now pass, per kind.

Any diff for the two current profiles is a regression. Stop and report it.

Run the sweep with a `DATABASE_URL` that reaches a real Postgres (the laptop `.env` points at `localhost:5432`).
Every board fetch reads the ETag cache (`free-ats-cache.ts`) first. With an unreachable database, each read waits
out the postgres.js reconnect backoff, only a couple of sockets stay open, and the sweep stalls for tens of
minutes. Claude hit this on 2026-10-22.

After deploy, Claude checks prod read-only: rows per day whose `gate_json` contains "working-student role" for
the 7 days before and the 2 days after. The rate must not drop to zero.
