# 2026-10-16: Telegram auto-apply, live audit + answer-page orchestration handoff

The orchestrating session stopped at its second compaction (founder rule). Three builders are running.
This file is the single place to resume from. The earlier QA handoff is
`docs/sessions/2026-10-16-ats-autoapply-qa-handoff.md`; read both.

## Founder asks (verbatim intent)
1. Two channels, both live-verified, before the verdict:
   (a) the bot asks the leftover questions in Telegram and he answers there;
   (b) instead of a screenshot, a hosted link on our VPS shows the filled form so he can finish the leftovers.
2. Design chosen (AskUserQuestion): **our answer page**. A phone-friendly VPS page lists every filled field
   (editable) plus the leftovers. Save makes the bot re-fill and Telegram shows 🚀 Submit. Answers are saved
   for next time. It is not a live remote browser.
3. Audit asked: why it gets stuck, why it "hallucinated" fills, why the agent doesn't handle it, and why the
   opened form is blank.

## Live baseline on prod (ddd0d904), `/apply j4b713482` = Telnyx Greenhouse, founder answering live
The Q&A mechanics work (ask → typed reply → 💾 saved → next question → re-fill → new card; 11/18 → 17/18).
Defects proven:

| # | Symptom | Root cause | Owner |
|---|---|---|---|
| 1 | "Are you based in The Netherlands or Ireland?" re-asked forever | `form-brain.ts` `buildFormFillPlan`: for non-choice fields `matchStandardTextField` runs before `lookupLearnedAnswer`; the location group matches "based in", so "Mohali, India" is typed into a Yes/No React-Select, fails, and the question is re-asked | ATS session |
| 2 | Card says filled, page shows empty "Location (City)" | `form-runner.ts` `typeIntoField` combobox branch counts typed text before blur, or any single-value, as verified; React-Select clears typed text on blur | ATS session |
| 3 | "This field is required." under filled fields | The same branch's ArrowDown+Enter fallback. Safe probe (`artifacts/qa/enter-submit-probe.ts`, gitignored; all non-GET aborted, submit events cancelled): 0 → 6 required errors on the NL step, 0 on the control step; 0 native submit events; 0 application POSTs (1 snowplow POST blocked). Proven: Enter triggers form-wide validation. **Hypothesis, not tested:** on a fully valid form it would submit without approval | ATS session |
| 4 | CV attached to the Cover Letter slot | Group-label bug (QA handoff root cause 8) | ATS session |
| 5 | No answers re-ask guard | `auto-apply.ts` `advanceAfterAnswer` re-asks any unfilled question, including ones answered this session | Agent A |
| 6 | "Open form" opens a blank form | `buildSubmitKeyboard(rowId, prep.targetUrl)` links the real ATS page; the filled copy lived only in headless Chromium on the VPS, closed after the screenshot | Agent A (hosted page) |
| 7 | Yes/No questions get no option buttons | React-Select scraped as text (QA handoff root cause 2) | ATS session |

## Builders (one writer per branch)
| Builder | Branch | Worktree | Scope |
|---|---|---|---|
| Linked session "Fix multi-ATS auto-apply form filling" (`local_dbd3437c-c033-4e35-ae7d-547ff7791fa3`) | `fix/jobhunt-ats-combobox-fill` (ca65ac36 at handoff) | `.claude/worktrees/optimistic-nash-b80cfc` | form-runner, form-brain, form-scraper, candidate-dossier, new form-combobox; rows 1–4, 7. Told: stop before merge/deploy; don't touch auto-apply.ts, health.ts, main.ts, bot.ts, `summariseFormPlan`/`FormPlanSummary` |
| Agent A (background subagent of the old session) | `feat/jobhunt-apply-answer-page` | `.claude/worktrees/agent-a338685cbbc9234c5` | Answer page: route `/apply/<rowId>.<exp>.<sig>` on the jobs health server (127.0.0.1:3001), HMAC-SHA256 token, 72 h expiry, per-row snapshot JSON (0600) in the data root, `filledAnswers` added in `summariseFormPlan` only, POST → `recordLearnedAnswer` → re-prepare → new card via bot API, per-row lock, never submits; card = text summary + URL button instead of the photo; env `APPLY_LINK_BASE_URL` / `APPLY_LINK_SECRET`, missing env fails loud. Plus rows 5–6 |
| Agent B (background subagent of the old session) | `chore/apply-link-funnel` | `.claude/worktrees/agent-a158fbbf0aa543d27` | Tailscale Funnel `/apply` → `http://127.0.0.1:3001/apply` on `turicks-dots.taile5afc3.ts.net`; deploy/env wiring (`deploy/deploy.sh`, `scripts/apply-prod-env-overrides.sh`, `scripts/infra/`) |

Agents A and B report to the old session. If it is gone, read their worktrees directly:
`git -C <worktree> log --oneline -5; git -C <worktree> status --short`.

## Next steps (fresh session)
1. Review each diff yourself (review is not delegable): tests first, files ≤ 400 lines, `allow-failopen` tags,
   no secrets, the page never submits, the token is checked before any read, and Funnel exposes only `/apply`.
2. `pnpm gate > /tmp/gate-$$.log 2>&1; echo exit=$?` on each branch. Open draft PRs to `beta` with What changed /
   How it was verified / NOT VERIFIED / `Checked first:`.
3. Merge order: ATS fixes → answer page → funnel. Then promote (`chore/promote-<slug>` = origin/main + merge
   origin/beta, `--merge`) and watch the deploy. Set `APPLY_LINK_SECRET` (random, VPS `.env` only) and
   `APPLY_LINK_BASE_URL=https://turicks-dots.taile5afc3.ts.net`. Never edit `/opt/founderos`.
4. Live test via `scripts/telegram-probe.ts` from the VPS (tester creds are only in the VPS `.env`; the tester is
   the founder's own account, so he sees the traffic): `/apply j4b713482`. Prove:
   - (a) an option button and a typed answer fill the fields, and 🚀 Submit unlocks;
   - (b) the hosted link opens over public HTTPS, prefilled; Save → a new card;
   - (c) the NL question is not re-asked.
   **Never press Submit** (`jh:s:`) without the founder's yes in chat.
5. Verdict report (table, screenshots, verified vs NOT VERIFIED), session doc, brain `save_bug` for rows 1–3
   (tag `founderos`), and "Outstanding from your end".

## Cleanup still owed
- VPS `~/qa-apply/` holds `apply-profile.backup-20261016T170247Z.json` (personal data). Do NOT restore it: the
  founder's real answers were saved after it. Delete the directory once the live test is done:
  `ssh founderos-vps 'rm -rf ~/qa-apply'`.
