# 2026-10-17 — Telegram auto-apply: live verdict

Follows `2026-10-16-ats-autoapply-qa-handoff.md`. Prod `8c8c4829` (promotion #1188 carried #1185, #1187, #1184, #1186).

## Verdict

Ready for daily use up to the 🚀 Submit button, on Greenhouse, Ashby, Lever and Workable. Submit itself is
NOT VERIFIED: nobody pressed it after the fixes, because a press sends a real application. Workday is unsupported.

## What we did

Drove `/apply j4b713482` (Greenhouse, Telnyx) on prod through Telegram with `scripts/telegram-tap.ts` (MTProto, as the
founder; the script refuses `jh:s:`). Opened the hosted answer page at phone width in a browser. Never pressed Submit.

| Step | Channel | Result |
|---|---|---|
| `/apply j4b713482` | Telegram | Card "Filled 16/18 · 2 unanswered (0 required)", answer-page button first, then "✅ Form ready" with Submit |
| Skip "Cover Letter" | Telegram button `jh:q:<row>:skip` | Toast "Skipped question", question 2/2 sent with 3 option buttons |
| Type the Veteran Status answer | Telegram text | "💾 Saved", re-fill, card 17/18, "✅ Form ready", no re-ask |
| Open the link | Public HTTPS (Tailscale Funnel) | 200, prefilled: 17 rows under "Already filled", file field read-only |
| Change one radio, Save | Answer page POST | "Saved 1 answer" (unchanged values skipped), fresh card 17/18 in Telegram; new link shows the new value |
| Tampered signature / tampered expiry | Public HTTPS | 404 / 404 |
| JSON POST | Public HTTPS | 415 |
| Cancel `jh:k:` | Telegram button | "Cancelled", snapshot file deleted, genuine link now 404 |
| Row state | Postgres `agents.job_applications` | `applied_at` null, `skipped_at` null |

Test answers were reverted afterwards: `apply-profile.json` and `candidate-dossier.md` sha256 match the pre-test backup.

## What we fixed (this cycle, all merged)

- #1185: the question loop (saved answers lose to the standard mapping), the false "filled" check on comboboxes
  (read before blur), and Enter firing form-wide validation.
- #1187: hosted answer page. The Telegram card links our prefilled page, not the blank company page.
- #1184: the `/apply` route is published on public HTTPS through Tailscale Funnel. Only `/apply` is exposed.
- #1186: `scripts/telegram-tap.ts`, which presses inline buttons as the founder and never presses Submit.

## Why

The founder reported "stuck, hallucinated, blank form". The causes were the loop, the false "filled" check, and the
"Open form" button that linked the blank company page.

## Outstanding

- Open defect: Telegram asks a file field ("Cover Letter") as a text question. A typed reply cannot fill a file input.
  `promptCurrentQuestion` in `src/gateway/apply-flow.ts` has no file branch. The answer page already shows it read-only.
- NOT VERIFIED: a real Submit (ATS accepts, row marked applied). Needs the founder's yes for one real application.
- NOT VERIFIED live: the 410 page for an expired link. Unit-tested only.
- Pre-existing and low risk: Submit does not re-check readiness, and "Form ready" does not mention a CAPTCHA.
  Both fail loudly, because Submit re-fills from scratch and marks a row applied only when the ATS confirms.
