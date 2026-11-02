# 2026-10-16: multi-ATS auto-apply QA, handoff

Branch `fix/jobhunt-ats-form-fill` (cut from `main` ddd0d904). Commits: b90e622d (failing tests from the live QA),
ca65ac36 (React-Select options, safe label matching, number fields, fast labels), f142dad9 (tsx evaluate shim,
`aria-labelledby` labels, svg-free label text, slow country picker), 362d4baf (exact-text combobox verify; only a
dial code may match as a suffix; regression locks for the prod loop and the CV slot). The building session reached its fourth
compaction and stopped there. The fill layer is fixed and live-checked on 4 ATS, and `pnpm gate` is green.
Still to do: the draft PR, the deploy, the Telegram proof and the verdict.

## Verdict so far: NOT ready for daily Telegram use

The form filling is now correct on Greenhouse, Ashby, Lever and Workable. The Telegram loop (ask → answer →
re-fill → 🚀 Submit unlocks) has not been run since these fixes. Until it is, the verdict stays "not ready".
Workday is unsupported.

## Before / after (live harness, never clicks submit)

"Required missing" after the fix counts only questions the founder must answer himself.

| ATS | Job | Before | After (f142dad9) |
|---|---|---|---|
| Greenhouse | Telnyx | 11/18, 4 required missing. City typed into the NL yes/no question; CV attached twice; Go/NL/OFAC with no buttons; country "verified" by an any-text check | 10/18, 4 required missing: Go, NL/Ireland and OFAC as Yes/No button asks, plus a legal-basis textarea. Country chosen and verified (control shows the dial code). Location "SAS Nagar Mohali, Punjab, India" verified. Visa = Yes verified. CV only in the Resume slot; Cover Letter asked |
| Ashby | EMA | 6/8, 1 missing. "Immediately" in a number field; salary expectation in Current Base Salary; radio group labelled "US Remote", not required | 6/8, 2 required missing: "Where are you located?" required radio group with option buttons, and Current Base Salary asked. Notice period numeric |
| Lever | AppZen | 9/16, 7 essays | 9/16, 7 essays (unchanged; they need the founder's own answers) |
| Workable | MLabs | Timed out (30 s per field with no `label[for]`) | Finishes in ~11 s. 4/19: names, email, Resume attached and verified. 13 required missing: 12 Yes/No experience radio groups with correct labels, 1 compound textarea. Photo optional, asked |
| Workday | n/a | unsupported | unsupported |

Every run took 9–14 s and exited 0. Screenshots and JSON are in `artifacts/qa/out/*-v4.*`. They are gitignored and
contain personal data, so do not share them.

## What the fixes do

- **Scraper:** one in-page snapshot computes labels (`label[for]` → `aria-labelledby` → aria-label → placeholder →
  ancestor walk), skipping `<svg>` text. Radio groups are named from `aria-labelledby` or the
  fieldset/legend. React-Select comboboxes are opened with ArrowDown so their options can be read.
- **`form-combobox.ts`:** chooses an option and verifies it after blur, including a control that shows only the
  dial code, as the Greenhouse phone-country picker shows "+91"; a shown place name never verifies. Async autocomplete types the first comma
  segment and picks with `pickAutocompleteOption`.
- **Brain/dossier:** whole-word option matching; semantic phrases matched at a word start with excludes
  (ethnicity ≠ city, current salary ≠ expectation, open source ≠ referral source); yes/no questions never get
  the city; number fields get a number or an ask.
- **`installEvaluateShim`:** tsx keepNames breaks in-page helpers. This only affects the harness and `pnpm dev`.
  Prod runs tsc output and was never affected.

## Commands

```bash
pnpm vitest run tests/unit/jobhunt/form-ats-qa.test.ts tests/unit/jobhunt/form-combobox.test.ts
pnpm gate > /tmp/gate-$$.log 2>&1; echo "exit=$?"
```

Last gate on 362d4baf: exit 0, 254 files, 3391 tests passed. Greenhouse re-run on 362d4baf: same as the table.

## Live harness setup (gitignored; never commit it or print profile values)

Job URLs:
- Greenhouse Telnyx: https://job-boards.greenhouse.io/telnyx54/jobs/8034464003
- Lever AppZen: https://jobs.lever.co/appzen/cce93662-196a-4814-b80c-bfa0b37384af
- Ashby EMA: https://jobs.ashbyhq.com/ema/f0865fe6-cd4c-449e-a564-80acde241a4f
- Workable MLabs: https://apply.workable.com/j/FB4C6D1E7A

```bash
mkdir -p artifacts/qa/out "$TMPDIR/qa-data"
scp founderos-vps:/opt/founderos-data/apply-profile.json founderos-vps:/opt/founderos-data/candidate-dossier.md "$TMPDIR/qa-data/"
```

`artifacts/qa/harness.ts` runs these steps in order:
1. Launch headless Chromium.
2. `classifyFormUrl` → `resolveFormTargetUrl` → `goto` → `revealPlatformForm`.
3. Screenshot `<tag>-before.png`.
4. `scrapePageFields` → `buildFormFillPlan(fields, profile, { resumePath }, dossier)` → `executeFormPlan` → `summariseFormPlan`.
5. Screenshot `<tag>-after.png`.
6. Write `<tag>.json` with labels, kinds and `{filled, total, reqMissing, optMissing, captcha, ready}`.

When summarising, print only labels, kinds, ok and why, never the values. Use placeholder env so config validation passes. On macOS, do not wrap the command in `timeout`; the command does not exist there.

```bash
APPLY_PROFILE_PATH=$TMPDIR/qa-data/apply-profile.json DATABASE_URL=postgres://qa:qa@127.0.0.1:1/qa TELEGRAM_BOT_TOKEN=0:qa TELEGRAM_CHAT_ID=1 npx tsx artifacts/qa/harness.ts gh-telnyx https://job-boards.greenhouse.io/telnyx54/jobs/8034464003 Telnyx
```

## Next

1. Open a draft PR from `fix/jobhunt-ats-form-fill` to `beta`, with sections What changed / How it was verified / NOT VERIFIED / `Checked first:`. Use the table above as the evidence.
2. After merge, promotion and deploy, drive `/apply <rank>` on one Greenhouse job through `scripts/telegram-probe.ts`:
   - Answer one question by button and one by text.
   - Show that the field fills and 🚀 Submit unlocks.
   - Never press Submit without the founder's yes.
3. Give the verdict "ready / not ready for daily Telegram use", with a reason for each point.
4. Known UX gap, not fixed: skipping the last required question still shows the Submit keyboard (`src/gateway/auto-apply.ts` ~310–320).
