# ADR-018: Job Applications — Founder Clicks, Machine Confirms Before Recording

**Status:** ACCEPTED
**Date:** 2026-08-11
**Context:** mac-client apply automation audit (P7-B) + false-positive confirmation fix

---

## Decision

`mac-client` may programmatically press the employer's own real submit control on a job-application form, but only under all of the following:

1. The founder personally reviewed the filled/left-blank field summary in the local overlay and pressed **SUBMIT & NEXT** himself. Nothing in the sync/wake/launchd path opens a browser or clicks anything unattended.
2. The form's own native validation passes (`checkValidity()`) before the click is attempted. A form with an unmet required field is never clicked — the founder is told which field blocked it and asked to finish it himself.
3. The ledger only ever records `applied` when no failure signal was observed after the click (a validation-error message appearing, a JS `alert`/`confirm` dialog, an HTTP error response where observable). A submission that cannot be positively distinguished from a failure is left unconfirmed — buttons re-enabled, nothing written to the ledger — never defaulted to `applied`.

This is stricter than "never auto-submit": the machine does press the real button, but it is never allowed to *claim* success it did not verify.

## Context

This ADR exists because two previous, opposite failures both actually happened in this pipeline:

- **The prototype.** Its submit line was commented out. The button recorded `applied` for every job while never touching the real form. The ledger disagreed with reality for a month before anyone noticed — silent, one-directional data corruption.
- **The 2026-08-09 fix attempt (`70212f6`), reverted same day (`e53dacf`).** It replaced the original blind timer with a URL-change/success-text/DOM-removal poll — safer in principle, but it never fired on forms that accept a submission via `preventDefault()` with no visible change (confirmed against the `greenhouse.html`/`lever.html` test fixtures, whose handlers do exactly this). The fix traded a false-positive risk for a false-negative one: a real submission going unrecorded, which drops a genuinely-applied job back into tomorrow's queue and risks a duplicate application. It was reverted back to the original blind-timer behavior, restoring the false-positive risk this ADR now closes.

Neither extreme is acceptable: recording `applied` for a submission that failed, and failing to record `applied` for a submission that succeeded, both corrupt the one signal the founder relies on to know what he's already applied to.

## Options Considered

### A: Fully autonomous — agent decides which jobs, clicks with zero human review
Rejected. Ban/legal risk on the ATS side, no correction path if the model misjudges a posting, and it removes the founder from a decision (which job to apply to, with what materials) that is his to make.

### B: Draft-only — human always submits on the real site, mac-client never touches the submit control
Safest option; still available as the fallback whenever `field_map_for()` returns `None` for an unrecognised ATS (zero automation on unknown forms, per `apply.py`). Rejected as the *only* mode because it throws away the auto-fill value entirely for the ATSes the tool does recognise — the founder re-types the same four fields on every posting for no safety benefit, since the click is already his either way.

### C (chosen): Human clicks a local overlay button; automation performs the real click and self-verifies before recording
Keeps the founder's click as the actual decision point (nothing happens without it) while removing the busywork of re-locating and clicking the real button on 20 different ATS layouts a day. The verification requirement (checkValidity + failure-signal detection) is what makes this different from a blind pass-through.

### D: Blind timer — click, wait a fixed interval, record `applied` unconditionally (the reverted-to state)
Rejected as the sole mechanism. This is the exact defect this ADR closes: zero verification means a validation error, a rejected submission, or a JS-intercepted click with no real effect is recorded identically to a real success.

## What Changed To Close This ADR

- `mac_client/mac_client/overlay.js`: pre-flight `checkValidity()` on the nearest form before clicking (refuses to click and reports which field is invalid, same honest-failure pattern as "could not find submit button"); post-click failure-signal detection (new error text appearing after the click, an intercepted `alert`/`confirm`/`prompt` dialog) races against the existing success signals (URL change, "thank you"/"application received" text, submit control detaching from the DOM); only when the settle window elapses with **no failure signal observed** does it fall back to `applied` — the same outcome as before for a genuinely ambiguous but non-erroring form, but now only after actively ruling out the two concrete failure modes that were previously invisible to it.
- `mac-client/tests/fixtures/required-field-missing.html`, `validation-error-shown.html` (new) + `mac-client/tests/test_apply_browser.py` (new tests) exercise both new failure paths against real Playwright-driven pages, per this project's rule that bug fixes start with a failing test.

## Resolution Criteria

This ADR stays ACCEPTED as long as `mac-client pytest` keeps the two failure-path tests green and the two original success-path tests (`test_submit_presses_the_employers_own_button`, `test_lever_submit_also_reaches_the_real_button`) also green — a change to `overlay.js` that breaks either side regresses one of the two failure modes this document exists to prevent.

## References

- `mac-client/mac_client/overlay.js`, `mac-client/mac_client/apply.py`
- `mac-client/tests/test_apply_browser.py`
- `docs/superpowers/specs/2026-08-08-jobhunt-apply-pipeline-audit-fix-design.md` (Finding 2 — the original audit that found this)
- Commit `70212f6` (the reverted fix attempt), commit `e53dacf` (the revert, findings D1-D4)
- `src/agents/prompts/jobhunt.ts` (hard limits — cites this ADR)
