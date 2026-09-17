# AG-014 — Gmail/GCal OAuth invalid_grant handled cleanly, not as a crash

**Milestone:** issue #687 item 1 (split — see `docs/plans/2026-09-16-issue-687-resolution-plan.md`)
**Branch:** `task/issue-<N>-oauth-invalid-grant` — cut from fresh `origin/beta`. PR base: `beta`.
**Status:** ✅ FIXED 2026-09-17 — see "Verification result" at the bottom.

**Read [STANDARDS.md](STANDARDS.md) in full before writing any code. It is binding.**

---

## Why this brief exists, not the original issue #687 item 1

Issue #687 named `src/integrations/google` as the file in scope. **That path does not exist in this
repo** (`ls src/integrations/google/` → no such file or directory) — confirmed 2026-09-16 while
triaging #687's `agent:failed` result. The real candidates, found by grepping for
`invalid_grant`/`gmail`/`calendar` across `src/`:

- `src/infra/providers/google-gws.ts`
- `src/infra/providers/google-composio.ts`
- `src/infra/providers/google-direct.ts`
- `src/infra/credential-resolver.ts`
- `src/tools/gmail-gws-read.ts`

Three parallel Google provider paths exist (`gws`, `composio`, `direct`) — which one the founder's
account actually uses in prod is not verified here. **Your first step is not to write code — it's
to find which provider path is live and where the `invalid_grant` actually surfaces**, per the
verify block below. A brief built on an unverified file path is exactly the defect class this
whole audit is about ([[docs/plans/2026-09-16-recurring-failure-patterns-and-behavior-audit.md]],
Theme 2/6) — don't repeat it here.

---

## Goal

Prod logs show Gmail/GCal OAuth token refresh failing with `invalid_grant` (the token was revoked
or expired at Google's end — this is not transient and retrying the same token will never succeed).
Today, this either crashes the calling loop or fails silently — which one is not yet confirmed.

**Done means:** the code path that refreshes/uses the Google OAuth token catches `invalid_grant`
specifically (not as a generic error), transitions that credential to a clearly "needs
re-authentication" state, and surfaces that state to the founder (a Telegram message or a
`read_logs`-visible signal) instead of crashing or silently no-op'ing on every subsequent call.

---

## Measured starting state — verify yourself before you begin, do not trust this list

```bash
grep -rn "invalid_grant" src/ tests/
grep -rln "invalid_grant\|OAuth\|refresh_token" src/infra/providers/ src/infra/credential-resolver.ts
```

Reproduce it if you can (check whether a test fixture or a captured prod log line for this error
exists — `read_logs` tool, `journalctl -u founderos.service`, filtered for `invalid_grant`). If you
cannot reproduce it, say so explicitly in the PR rather than guessing at the failure shape.

---

## Files in scope (confirm, don't assume)

| Path | Expected change |
|---|---|
| Whichever of `src/infra/providers/google-{gws,composio,direct}.ts` actually owns token refresh | catch `invalid_grant` specifically, transition credential state |
| `src/infra/credential-resolver.ts` | if this is the shared resolution point, the state transition likely belongs here instead — check before choosing |
| the caller loop currently crashing (identify via reproduction) | stop treating `invalid_grant` as a generic/retryable error |
| a new or existing alerting path to Telegram | surface "Google account needs re-authentication" once, not on every call |
| `tests/unit/infra/` (matching existing test location for this area) | regression test for the `invalid_grant` catch |

## Explicitly forbidden

- Do not silently swallow `invalid_grant` and continue as if the call succeeded — that's the
  fail-open pattern this whole audit exists to stop
  ([[docs/plans/2026-09-16-mechanism-fail-open-silent-defaults.md]]).
- Do not retry `invalid_grant` with backoff — it is not a transient error, retrying wastes budget
  and delays surfacing the real problem.
- Do not touch the other two Google provider paths you determine are not the live one.
- No `any`, no `console.log` — `pnpm verify:arch` enforces both.

## Verify

```bash
pnpm gate
```

State in the PR body: which provider file actually owns this, whether you could reproduce the
crash, and — per [[docs/plans/2026-09-16-recurring-failure-patterns-and-behavior-audit.md]] rule
#36 — one real-path assertion (a `read_logs` grep showing the new clean-failure message in place of
the old crash trace, or an explicit **NOT VERIFIED — reason** if a live reproduction isn't
possible in this environment).

---

## Verification result (2026-09-17)

**Which provider owns this:** confirmed via prod `.env` — `GMAIL_BACKEND=gws`,
`CALENDAR_BACKEND=gws` — so `src/infra/providers/google-gws.ts` is the live path.
`google-composio.ts` and `google-direct.ts` were not touched.

**Reproduced — this was NOT a hypothetical.** `runProviderSmokeAtBoot` (boot-only, `src/index.ts`)
already classified and alerted on `invalid_grant`, but grepping 60 days of prod logs for
`"module":"provider:gws"` (the LIVE call path, not the boot probe) found real, founder-initiated
tool calls hitting this exact error with zero classification:

```
Aug 08 06:43:40 … {"module":"provider:gws","err":"...invalid_grant: Bad Request...",
  "query":"in:inbox","msg":"gws Gmail list failed"}
Aug 14 04:17:42 … {"module":"provider:gws","err":"...invalid_grant: Bad Request...",
  "query":"in:sent after:2026/06/30 before:2026/08/01","msg":"gws Gmail list failed"}
Aug 14 08:28:07 … {"module":"provider:gws","err":"...invalid_grant: Bad Request...",
  "query":"in:sent after:2026/06/30 before:2026/08/01","msg":"gws Gmail list failed"}
```

**Confirmed which failure mode:** neither "crashes" nor "silent" — it returned
`{success:false, error: "gws Gmail read failed: <raw gws stderr>"}`, a normal `ToolResult` failure
with no special classification, no founder alert, and no "this cannot be retried" signal. The
founder would only learn about it from the NEXT process restart's boot probe — which, per the
Aug 20 log window (10 restarts in 27 hours), can be minutes away or can be days away depending on
uptime.

**Fix:**
- `alertOnCredentialFailure()` / `clearCredentialAlert()` added to `provider-probes.ts`: classify a
  live failure, alert once per outage episode (deduped, same shape as `judge-health.ts`), reset on
  the next success.
- `google-gws.ts`'s three live call sites (`gwsReadEmails`, `gwsSendEmail`,
  `gwsCreateCalendarEvent`) now call it on failure and return a clear
  "needs re-authorization... will not resolve on retry" message instead of the raw gws stderr, and
  clear the episode on success.
- Per "explicitly forbidden": no retry-with-backoff added (not a transient error); `google-composio.ts`
  and `google-direct.ts` untouched.

**Verify:**
```
$ npx vitest run tests/unit/infra/providers/google-gws.test.ts tests/unit/infra/provider-credential-alert.test.ts
 Test Files  2 passed (2)
      Tests  14 passed (14)

$ pnpm gate
 Test Files  401 passed (401)
      Tests  4467 passed (4467)
```
Live reproduction of the fix itself (deliberately revoking the real prod Gmail/Calendar grant to
confirm the new alert fires) was **NOT attempted** — that would break real Gmail/Calendar access
for the founder to test a code path already proven correct at the unit level against the exact
real historical error string. Unit-level reproduction against genuine prod log lines (above) is
the proportionate verification here.
