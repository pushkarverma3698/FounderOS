# AG-014 — Fresh-first jobhunt: Blocks A + B (truth fixes + command surface)

**Goal:** Fix five mislabels in the brief, then build a unified command surface (`/jobs`, `/today`, `/fresh`) and natural language resolver that share one code path so they can never drift.

**Context:** See [`docs/plans/2026-09-08-fresh-first-jobhunt.md`](../plans/2026-09-08-fresh-first-jobhunt.md) for the full audit and diagnosis. This task implements Blocks A and B only.

**Size:** ~8h, one PR to `beta`.

---

## Block A — Truth Fixes (3h)

### A1: Show both posted date + discovery lag (not just "seen today")

**What:** Rows currently show `seen today` / `seen 3d ago`, rendering `created_at` (when we stored it). A row posted 13 days ago that we discovered today reads as "today's".

**Fix:**
- **File:** `src/tools/jobhunt/brief-row.ts:253`
  - Current: `<i>seen ${row.ageDays === 0 ? "today" : `${row.ageDays}d ago`}</i>`
  - New: `<i>posted ${formatPostAge(row.postedAt, now)} · found ${formatDiscoveryAge(row.createdAt, now)}</i>`
  - Add helper functions `formatPostAge(date, now)` and `formatDiscoveryAge(date, now)` that return "today" / "1d ago" / "13d ago" as appropriate

- **File:** `src/tools/jobhunt/brief-assemble.ts`
  - The row already has `posted_at`, so no new data needed — just pass it through to the renderer

- **Test:** `tests/unit/jobhunt/truth-audit.test.ts` (new)
  - A row posted 6 days ago, discovered 2 hours ago, renders as: `posted 6d ago · found today`
  - A row posted today, discovered today, renders as: `posted today · found today`

### A2: Remove the silent 100-row cap; print when rows are cut

**What:** `listActionableApplications` defaults to `.limit(100)`. Pushkar has 166 qualifying rows; brief loads 100 and says nothing about the cut. 66 fresh roles invisible.

**Fix:**
- **File:** `src/tools/jobhunt/daily-brief.ts`
  - Line 182: Change `queueWindowFor(profile)` call to also capture a desired limit
  - Pass `{ maxAgeHours, limit: 500 }` to `listActionableApplications` (or some high number that won't cut)
  - Add logic: if `applications.length >= limit`, set a flag and note how many were cut

- **File:** `src/tools/jobhunt/brief.ts`
  - Add a cut-notice line to the header when it happens: `showing 100 of 166 fresh roles in the queue`
  - Always state the window: `(100 most recent, < 24h old)`

- **Test:** `tests/unit/jobhunt/brief-cap.test.ts` (new)
  - 166 qualifying rows input → brief loads all 166, no cut notice
  - 500 qualifying rows input → brief loads 100, header says `showing 100 of 500`

### A3: `N screened` → `N in your queue`; feed the real screening count where one exists

**What:** Brief prints `100 screened · ai 22 · backend 67 …`. "Screened" is a machine term: ~83k postings per sweep actually get screened. The brief's 100 is the queue size.

**Fix:**
- **File:** `src/tools/jobhunt/daily-brief.ts:274`
  - Current: `screened: opts.screened ?? applications.length`
  - New: Add an optional `totalScreenedThisSweep` to `BriefInput`, default to undefined
  - In the funnel data we already have, the count of rows that reached `screened` stage

- **File:** `src/tools/jobhunt/brief.ts:385`
  - If `totalScreenedThisSweep` is provided, print: `123,456 postings screened today`
  - If not, print nothing (for now)
  - The queue size is already printed elsewhere in freshness line

- **Test:** `tests/unit/jobhunt/brief-screened-count.test.ts` (new)
  - With screening count: header says `83,132 postings screened today`
  - Without: no screening count printed

### A4: Cost line: retitle to 3 days, fix `failed`, drop dead branch, label tenant-wide

**What:** Header says `💰 WHAT TODAY COST` but reports a 3-day window (verified: 280 calls/459 postings match 3-day SQL). Also: `failed` means "had a board error", not "failed"; `"the rest already in your list"` when `fresh == returned`.

**Fix:**
- **File:** `src/tools/jobhunt/daily-brief.ts:314`
  - Change window comment to make it clear: 3 days, not 1 day

- **File:** `src/tools/jobhunt/brief-sections.ts:250`
  - Title: `<b>💰 LAST 3 DAYS</b>`
  - `failed` → `boards_with_errors` (in the variable name and label)
  - When `failed > 0`, print: `${failed} ATS boards had errors during collection but returned partial results`
  - Drop the `yielded` branch when `fresh == returned` (both should be equal for free lane)
  - Add a note below the cost line (italics): `Tenant-wide figure across all profiles — TODO once Q-3 is fixed`

- **Test:** `tests/unit/jobhunt/cost-line.test.ts` (new)
  - 3-day window renders as `LAST 3 DAYS`
  - 280 runs, 459 returned, 280 with errors → `280 ATS boards had errors during collection but returned partial results`
  - `fresh == returned` (true for free lane) → no "the rest already in your list" line

### A5: Alert fires on publish-freshness, not first-seen; backfill gets a quieter line

**What:** `formatNewRowsAlert` fires on `isNew` (first-seen-by-us), so a 13-day-old posting discovered today pings as 🆕. Also missing `/draft N` inline.

**Fix:**
- **File:** `src/tools/jobhunt/free-sweep-profile.ts`
  - Change: separate `newRoles` into two lists:
    - `newRoles` = posted in last 24h AND isNew (genuinely fresh)
    - `backfill` = posted >24h ago AND isNew (newly discovered, older postings)
  - If `newRoles.length > 0`, call the alert with those
  - If `backfill.length > 0` and `newRoles.length == 0`, send a quieter line: `+ ${backfill.length} older roles added to your list` (no ping, no emoji)

- **File:** `src/tools/jobhunt/sweep-heartbeat.ts:228`
  - Add `/draft N` inline on every named row: `✅ Company Name — Role Title · /draft 3`
  - Add the apply link inline: `<a href="url">/draft 3</a>`

- **Test:** `tests/unit/jobhunt/alert-freshness.test.ts` (new)
  - A 2h-old newly discovered role → fires alert with 🆕 emoji
  - A 13d-old newly discovered role → fires quiet backfill line (no emoji)
  - Each named row in alert carries `/draft N` and the link

---

## Block B — Command Surface (5h)

### B1: Argument resolver — one parser for slash + natural language

**File:** `src/tools/jobhunt/brief-resolver.ts` (new)

Create a single parser that converts both:
- Slash args: `/jobs wife 2d` → `{ who: 'wife-nl-finance', verb: 'jobs', range: '2d', axis: 'posted' }`
- NL intent from planner: "tashi's last 2 days jobs founded" → `{ who: 'wife-nl-finance', verb: 'jobs', range: '2d', axis: 'found' }`

**Interface:**
```typescript
export interface BriefRequest {
  who: ProfileScope;           // omitted = self · wife/tashi = wife-nl-finance · me/pushkar = pushkar-nl-tech
  verb: 'jobs' | 'today' | 'fresh';
  range?: string;              // "2d", "48h", "this week", undefined = verb default
  axis?: 'posted' | 'found';   // which date field. defaults per verb (jobs: posted, fresh: found)
}

export function parseBriefRequest(
  slashArgs?: string[],
  nlIntent?: { who?: string; range?: string; axis?: string },
  verb?: string,
): BriefRequest
```

**Mapping:**
- `/jobs [who] [range]` → `{ verb: 'jobs', who, range, axis: 'posted' }`
- `/today [who]` → `{ verb: 'today', who, axis: 'posted' }` (range fixed to 24h)
- `/fresh [who]` → `{ verb: 'fresh', who, axis: 'found' }` (range undefined, means "since last run")

NL examples:
- "tashi's jobs" → `{ who: 'wife-nl-finance', verb: 'jobs', axis: 'posted' }`
- "tashi's last 2 days jobs founded" → `{ who: 'wife-nl-finance', verb: 'jobs', range: '2d', axis: 'found' }`
- "show me my fresh" → `{ who: 'pushkar-nl-tech', verb: 'fresh', axis: 'found' }`

**Test:** `tests/unit/jobhunt/brief-resolver.test.ts` (new)
- Slash: `/jobs wife 2d` → correct parsed object
- Slash: `/today` → correct defaults
- NL: "tashi's jobs" → correct who + verb
- NL: "last 2 days jobs founded" → correct range + axis

### B2: `/jobs [who] [range]` — full brief, no age limit

**File:** `src/tools/jobhunt/telegram.ts` (commands section)

Add command:
```typescript
bot.command('jobs', async (ctx) => {
  const args = ctx.match?.split(/\s+/).filter(Boolean) || [];
  const req = parseBriefRequest(args, undefined, 'jobs');
  const brief = await buildDailyBrief({
    profile: getProfile(req.who),
    now: new Date(),
    axis: req.axis,
  });
  await ctx.reply(brief, { parse_mode: 'HTML' });
});
```

**Test:** `tests/unit/jobhunt/commands.test.ts` (new or extend)
- `/jobs` → your full brief
- `/jobs wife` → Tashi's full brief
- `/jobs 3d` (no who) → your 3d brief
- `/jobs wife 1 week` → Tashi's full brief (range ignored, no age limit for `/jobs`)

### B3: `/today [who]` — posted < 24h

**File:** `src/tools/jobhunt/telegram.ts` (commands section)

Add command:
```typescript
bot.command('today', async (ctx) => {
  const args = ctx.match?.split(/\s+/).filter(Boolean) || [];
  const req = parseBriefRequest(args, undefined, 'today');
  const brief = await buildDailyBrief({
    profile: getProfile(req.who),
    now: new Date(),
    maxAgeHours: 24,
    axis: 'posted',
  });
  await ctx.reply(brief, { parse_mode: 'HTML' });
});
```

**Test:** `tests/unit/jobhunt/commands.test.ts`
- `/today` → your 24h brief, posted-date only
- `/today wife` → Tashi's 24h brief

### B4: `/fresh [who]` — discovered since last run, one message, `/draft N` per row

**File:** `src/db/job-queries.ts`

Add tracking for each profile:
```typescript
export async function recordFreshViewTime(profileId: string, now: Date): Promise<void>
export async function lastFreshViewTime(profileId: string): Promise<Date | null>
```

These track `fresh_viewed_at` per profile (new column in `job_applications` or a separate tracking table).

**File:** `src/tools/jobhunt/telegram.ts` (commands section)

Add command:
```typescript
bot.command('fresh', async (ctx) => {
  const args = ctx.match?.split(/\s+/).filter(Boolean) || [];
  const req = parseBriefRequest(args, undefined, 'fresh');
  const profile = getProfile(req.who);
  const lastSeen = await lastFreshViewTime(profile.id);
  const now = new Date();
  
  const brief = await buildDailyBrief({
    profile,
    now,
    mode: 'fresh',
    sinceDate: lastSeen, // rows discovered after this
    axis: 'found',
  });
  
  await recordFreshViewTime(profile.id, now);
  await ctx.reply(brief, { parse_mode: 'HTML' });
});
```

**File:** `src/tools/jobhunt/brief.ts`

Add `mode: 'fresh'` to `BriefInput`:
- One message only (no pagination)
- Per-row format: `✅ Company · Title · one-line why · /draft N`
- No sections, no evidence blocks, no trends

**Test:** `tests/unit/jobhunt/commands.test.ts`
- `/fresh` → discovers only roles found since your last `/fresh`
- `/fresh wife` → Tashi's newly discovered roles
- Rows are numbered 1, 2, 3… (matching persistent `brief_rank`)

### B5: `/draft N` resolves to the same row across verbs

**File:** `src/tools/jobhunt/brief-row.ts`

All rows carry a stable `brief_rank: number` (persisted in the DB, set when a row first enters the brief). The rank is how a `/draft` command finds it.

**Test:** `tests/unit/jobhunt/draft-numbering.test.ts` (new)
- Build `/jobs`, `/today`, `/fresh` with overlapping rows
- Row X gets rank 5 in all three
- `/draft 5` resolves to the same row regardless of which command listed it

### B6: Alert carries `/draft N` + apply link inline

**File:** `src/tools/jobhunt/sweep-heartbeat.ts:228` (already done in A5, but verify here)

Alert line format:
```
🆕 3 new roles for Tashi
1 cleared every check · 2 need a question first

✅ Company A — Role Title  /draft 1  https://link
❓ Company B — Role Title  /draft 2  https://link
❓ Company C — Role Title  /draft 3  https://link
```

**Test:** `tests/unit/jobhunt/alert-format.test.ts` (new)
- Alert has `/draft N` inline on each row
- Each row links to the apply URL
- Mark (✅ vs ❓) matches the outcome

### B7: Command help + updated command list

**File:** `src/gateway/commands.ts`

Update the `/help` output to list:
- `/jobs [who] [range]` — full brief
- `/today [who]` — roles posted today (< 24h)
- `/fresh [who]` — roles you haven't seen yet
- `/draft N` — tailor and apply to role N
- `/ask N` — ask the founder a question before applying
- `"show me my jobs"` or `"tashi's fresh"` — natural language works too

**Test:** `tests/unit/jobhunt/help.test.ts` (new)
- `/help` includes all three verbs
- NL example in help text

---

## Verification Checklist

Before opening the PR:

- [ ] **A1** — Screenshot: a row posted 6d ago, discovered today, renders both ages
- [ ] **A2** — Pushkar's brief shows all 166 qualifying rows or states the cut
- [ ] **A4** — Cost line title says "LAST 3 DAYS"
- [ ] **A5** — A 2h-old new role alerts with 🆕; a 13d-old new role alerts without emoji
- [ ] **B1** — Resolver test passes for slash and NL inputs
- [ ] **B2–B4** — `/jobs`, `/today`, `/fresh` each work on Telegram (real bot, not mock)
- [ ] **B5** — `/draft 3` resolves to the same row after `/jobs` and after `/fresh`
- [ ] **B6** — Alert message includes `/draft N` and the apply link
- [ ] `pnpm gate` exits 0
- [ ] All new tests pass

---

## Files Changed Summary

**New files:**
- `src/tools/jobhunt/brief-resolver.ts`
- `tests/unit/jobhunt/truth-audit.test.ts`
- `tests/unit/jobhunt/brief-cap.test.ts`
- `tests/unit/jobhunt/brief-screened-count.test.ts`
- `tests/unit/jobhunt/cost-line.test.ts`
- `tests/unit/jobhunt/alert-freshness.test.ts`
- `tests/unit/jobhunt/brief-resolver.test.ts`
- `tests/unit/jobhunt/commands.test.ts`
- `tests/unit/jobhunt/draft-numbering.test.ts`
- `tests/unit/jobhunt/alert-format.test.ts`
- `tests/unit/jobhunt/help.test.ts`

**Modified files:**
- `src/tools/jobhunt/brief-row.ts` (A1)
- `src/tools/jobhunt/brief-assemble.ts` (A1)
- `src/tools/jobhunt/daily-brief.ts` (A2, A3)
- `src/tools/jobhunt/brief.ts` (A2, A3)
- `src/tools/jobhunt/brief-sections.ts` (A4)
- `src/tools/jobhunt/free-sweep-profile.ts` (A5)
- `src/tools/jobhunt/sweep-heartbeat.ts` (A5, B6)
- `src/db/job-queries.ts` (B4)
- `src/tools/jobhunt/telegram.ts` (B2–B4, B7)
- `src/gateway/commands.ts` (B7)

---

## Deliverable

One PR to `beta`, squashed, with message:

```
feat(jobhunt): truth fixes + fresh-first command surface

Blocks A + B from the supply-asymmetry plan (AG-014).

A — Truth fixes:
  A1: Rows show both posted + discovery age, not just "seen today"
  A2: Kill the silent 100-row cap; print when roles are cut
  A3: Queue size → "N in your queue"; feed real screening count where available
  A4: Cost line retitled "LAST 3 DAYS", `failed` relabeled, dead branch dropped
  A5: Alert fires on publish-freshness, not first-seen; backfill quieter; `/draft N` inline

B — Command surface (one resolver, slash + NL):
  B1: Unified argument parser (slash args + NL intent)
  B2: `/jobs [who] [range]` — full brief, no age limit
  B3: `/today [who]` — posted < 24h
  B4: `/fresh [who]` — discovered since you last ran it
  B5: `/draft N` stable across all verbs
  B6: Alert carries `/draft N` + link inline
  B7: Help updated

All five truth audits verified on prod. All three commands tested on real Telegram.
```

---

## Ready

Proceed when you see this file. No further clarification needed.
