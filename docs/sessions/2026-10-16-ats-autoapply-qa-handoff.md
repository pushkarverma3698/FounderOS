# 2026-10-16: multi-ATS auto-apply QA, handoff

Branch `fix/jobhunt-ats-form-fill` (cut from `main` ddd0d904). The session that wrote this hit its
second compaction and stopped, per the founder's rule. The live QA and the diagnosis are complete;
the code fixes are not started. Two failing test files are committed and must go green.

## Verdict so far: NOT ready for daily Telegram use

| ATS | Job | Filled / total | Required missing | Submit ready | Main defect |
|---|---|---|---|---|---|
| Greenhouse | Telnyx | 11 / 18 | 4 | no | React-Select questions scraped as text (no buttons); city typed into a yes/no question; CV attached twice (cover-letter slot labelled "Resume/CV"); country/location "verified" by a check that accepts any text |
| Ashby | EMA | 6 / 8 | 1 | no | "Immediately" typed into a number field; salary expectation typed into "Current Base Salary"; radio group labelled with its first option ("US Remote") and not marked required |
| Lever | AppZen | 9 / 16 | 7 | no | Works as designed: the 7 missing are essay questions the founder must answer |
| Workable | MLabs | did not finish | n/a | no | Every field without `label[for]` waits Playwright's 30 s default; run times out and the page closes |
| Workday | n/a | unsupported | n/a | n/a | Out of scope; say so in the verdict |

Not reproduced: the Greenhouse "required" submit errors (no submit was attempted; only analytics POSTs fired).
Not yet proven: the Telegram HITL loop (ask → answer → re-fill → 🚀 Submit unlocks).

## Root causes

1. **Scraper `labelForElement`** (`form-scraper.ts` ~118–150) calls `locator('label[for=…]').first().textContent()`,
   which waits 30 s when the label is absent. Also, the per-field `locator(...).nth(r.idx)` after a page-wide
   evaluate races DOM changes.
2. **React-Select comboboxes** have no `<select>`. Options exist only in a listbox after ArrowDown
   (`aria-controls` is set only while open). The scraper never reads them, so yes/no questions become
   free-text asks with no buttons, and the runner's combobox branch types the full value and clicks a
   regex-matched `[class*=option]`.
3. **Runner verification** for comboboxes accepts any single-value text, so a wrong pick reports "verified".
4. **`matchChoiceOption`** substring match cannot tell "India +91" from "British Indian Ocean Territory +246".
5. **`SEMANTIC_RULES`** match by `normKey.includes(phrase)`: "ethnicity" contains "city"; "netherlands or ireland"
   contains "land"; "current base salary" hits the salary rule; "open source" hits referral "source".
6. **`labelMatches` location/country groups** fire on yes/no questions ("Are you based in …").
7. **Number fields** get free text ("Immediately").
8. **Group labels** (Ashby fieldset, Greenhouse file groups) take the first label walking up, which is an
   option label or the inner "Attach" label.

## Fix design (keep every src file ≤ 400 lines; current: runner 397, brain 385, scraper 383, dossier 381)

1. **Scraper:** compute labels and `<select>` option texts inside the single `page.evaluate` snapshot.
   In-browser `labelOf(e)`: `label[for]` text unless it is attach/upload/clear/remove/browse/choose file →
   `aria-label` → placeholder (unless generic: select/type here/enter/choose) → walk up 6 ancestors for
   `legend, label, strong, [class*='label' i]` text of 1–220 chars, skipping clear/remove/attach/upload.
   Delete `labelForElement`. Keep `[id="…"]` locators only where still needed (comboboxes).
2. **Combobox options at scrape time:** for `input[role=combobox]` with an id, `readComboboxOptions`
   (focus, ArrowDown, wait ~300 ms, read `[role=option]` from `getElementById(aria-controls)` else the
   closest container's `[id*="-option-"]`, Escape, blur). Options found → type `select` with options.
   None (async autocomplete, e.g. Greenhouse country/location) → stays text.
3. **`groupLabelFor(page, name, options)` returns `{label, required}`:** per ancestor (8 levels) scan
   `legend, label, [class*='label' i]:not(input):not(select):not(textarea)`; first text of 4–250 chars that is
   not clear/remove and not equal to an option text. `required = /[*✱]\s*$/` on the text or `/required/i`
   on the className. Use `r.required || group.required`. Add `querySelectorAll` to the `DomElement` type.
   Change `requiredFromLabel` to `/[*✱]\s*$/` (Lever uses ✱).
4. **New `src/tools/jobhunt/form-combobox.ts`:**
   - `readComboboxOptions(page, input)`
   - `chooseComboboxOption(page, input, option)`: open, click the exactly-matching option by index, blur, verify
     the single-value text in `closest('[class*="control" i]')` equals the option.
   - `typeIntoCombobox(page, input, value)`: type the first comma segment, poll ≤ 4 s for options,
     `pickAutocompleteOption`, click, blur, verify equality; no match → Escape, blur, return false.
   - Pure `pickAutocompleteOption(value, options)`: the first segment must appear in the option as a whole
     word (normalised); prefer the option containing the most other segments; ties keep provider order; else null.
   - Runner: `typeIntoField` combobox branch → `return typeIntoCombobox(...)`; `chooseInField` select path checks
     `role=combobox` first → `chooseComboboxOption`. Frees ~25 lines in the runner.
5. **candidate-dossier:** (a) `matchChoiceOption`: with several substring matches, keep options containing
   the desired text as a whole word; one left → return it. (b) SEMANTIC phrases match at a word start:
   `(" " + normKey).includes(" " + phrase)`. (c) Optional `excludes` per rule: salary excludes `current`,
   referralSource excludes `open source`. (d) Export `explicitAnswerFor(question, profile, dossier)`
   (question_bank exact normalised key, then dossier Q&A); `lookupLearnedAnswer` uses it.
6. **form-brain:** (a) `labelMatches` location/country groups return false when the label starts with
   are/do/does/did/have/has/is/can/could/will/would/should. (b) For non-choice fields call `explicitAnswerFor`
   before `matchStandardTextField`; replace the duplicated bank lookups in `chooseEligibility` and the eligibility
   branch with it. (c) `type === "number"` value actions: keep a leading number (`-?\d+(?:[.,]\d+)?`, comma → dot);
   `/immediate|asap/i` → "0"; anything else → ask (required = field.required).

Expected after the fixes: Greenhouse country "India +91", location "SAS Nagar Mohali, Punjab, India", Go and
NL/Ireland and OFAC as Yes/No button asks, CV only in the Resume slot. Ashby notice "0", base salary an ask, radio
group "Where are you located?" required with option buttons. Lever unchanged. Workable finishes.

## Tests (committed, failing now)

- `tests/unit/jobhunt/form-ats-qa.test.ts`: pure; fails at import until `form-combobox.ts` exists.
- `tests/unit/jobhunt/form-combobox.test.ts`: Playwright fixture (React-Select, async autocomplete, Ashby
  fieldset, Greenhouse file groups, a field with no `label[for]`); both cases time out at 30 s today.

```bash
pnpm vitest run tests/unit/jobhunt/form-ats-qa.test.ts tests/unit/jobhunt/form-combobox.test.ts
```

## Live re-run after the fixes (never clicks submit)

Live job URLs used:
- Greenhouse Telnyx: https://job-boards.greenhouse.io/telnyx54/jobs/8034464003
- Lever AppZen: https://jobs.lever.co/appzen/cce93662-196a-4814-b80c-bfa0b37384af
- Ashby EMA: https://jobs.ashbyhq.com/ema/f0865fe6-cd4c-449e-a564-80acde241a4f
- Workable MLabs: https://apply.workable.com/j/FB4C6D1E7A
- Optional: SmartRecruiters Wise https://jobs.smartrecruiters.com/Wise/744000155771274 ,
  Recruitee Metyis https://metyisag.recruitee.com/o/associate-data-scientist-1

Setup (the harness and personal data are gitignored; never commit them or print their contents):

```bash
mkdir -p artifacts/qa/out "$TMPDIR/qa-data"
scp founderos-vps:/opt/founderos-data/apply-profile.json founderos-vps:/opt/founderos-data/candidate-dossier.md "$TMPDIR/qa-data/"
```

`artifacts/qa/harness.ts`: launch headless Chromium, `classifyFormUrl` → `resolveFormTargetUrl` → `goto` →
`revealPlatformForm` → screenshot `<tag>-before.png` → `scrapePageFields` → `buildFormFillPlan(fields, profile,
{ resumePath }, dossier)` → `executeFormPlan` → `summariseFormPlan` → screenshot `<tag>-after.png` → write
`<tag>.json` with fields, plan, and `{filled, total, reqMissing, optMissing, captcha, ready}`. Imports come from
`../../src/tools/jobhunt/*`. Run with placeholder env so config validation passes:

```bash
APPLY_PROFILE_PATH=$TMPDIR/qa-data/apply-profile.json DATABASE_URL=postgres://qa:qa@127.0.0.1:1/qa TELEGRAM_BOT_TOKEN=0:qa TELEGRAM_CHAT_ID=1 npx tsx artifacts/qa/harness.ts gh-telnyx https://job-boards.greenhouse.io/telnyx54/jobs/8034464003 Telnyx
```

## Then

1. `pnpm gate` green, draft PR to `beta` (What changed / How it was verified / NOT VERIFIED / `Checked first:`).
2. After deploy: drive `/apply <rank>` on one Greenhouse job through `scripts/telegram-probe.ts`, answer one
   question by button and one by text, and show that 🚀 Submit unlocks. Do not press Submit without the founder's yes.
3. Known UX gap (not fixed): skipping the last required question still shows the Submit keyboard
   (`src/gateway/auto-apply.ts` ~310–320).
