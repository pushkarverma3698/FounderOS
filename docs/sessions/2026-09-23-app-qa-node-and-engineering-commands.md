# 2026-09-23 — The last node: browser verification, and an engineering surface in Telegram

## What we did

Closed the one missing arrow in the dispatch loop and made the whole loop legible from a phone.

**1. `pnpm qa:app` — the app QA node.** Boots a pull request's checkout (`npm ci` → build → serve
on a loopback port → poll until it answers), renders its public routes in headless Chromium at
desktop and mobile, and emits the same evidence pack the static UI gate already produced. Three
exit codes, not two: `0` clean · `1` blocking or won't boot · `3` not applicable. The third exists
because `0` would make *did not run* indistinguishable from *found nothing*.

- `src/tools/browser/app-recipes.ts` — PURE. Per-repo install/build/start/port/routes/trigger
  paths/env, plus `annotateExpectedExternal`.
- `src/tools/browser/app-server.ts` — I/O. Every failure is RETURNED, never thrown; commands run
  in their own process group so a stopped server cannot leave vite holding the port for the next PR.
- `scripts/qa-app.ts` — the CLI.
- `docs/antigravity/APP-QA-NODE.md` — the contract.

**2. Wired it into the gate.** `deploy/vps-daemons/pr-brain` runs it BEFORE dispatching the
reviewer, posts the pack as one in-place PR comment marked `<!-- app-evidence -->`, and sends up to
two screenshots per gated head to Telegram. `pr-adversary` gained step 6b, which requires reading
that pack (or saying, in words, which of the two reasons stopped it running).

**3. Telegram engineering surface.** New `/tasks` — the loop's state in one message, grouped by
`agent:*` label with what each state means. `/task`, `/tasks`, `/newproject` moved out of "System"
into their own Engineering group in the ☰ menu, and `/commands` now explains the six stages of what
happens after you send `/task`, not just the three verbs.

## What we fixed

| # | Defect | Where it lived |
|---|---|---|
| 1 | **`/task repo:hulda` was a silent dead end.** Allowlisted, named in `/task`'s own usage text, and absent from the dispatcher's repo list, with no workspace, no review checkout and no `agent:*` labels. The issue would be filed and never claimed — no error, no timeout, no message. | `deploy/agent-dispatch` + VPS |
| 2 | **`deploy/agent-dispatch` was the stale half of a hot fix.** The VPS carried `pr_for_issue()` (the fix for the dead review→fix arrow) and per-repo base branches; the repo carried neither. Restoring from the repo would have silently re-broken both. | repo ↔ VPS drift |
| 3 | **`pr-adversary` step 1 ran a laptop-only binary.** `agy-guard` is not on the VPS, where every unattended gate runs. | skill |
| 4 | **Console errors carried no URL.** Chromium's message for a failed request is a bare `net::ERR_…`, unactionable and — for the new gate — unattributable. | `ui-facts.ts` |
| 5 | **`/tasks` would throw on a busy queue.** 40 rows rendered 5,638 of Telegram's 4,096 budget: the command would answer *nothing* exactly when the queue was most interesting. Capped, and the cap keeps `blocked`/`failed` over `ready`. | caught by its own test |
| 6 | **`bootApp` waited 90s for a process that had already exited.** | caught by its own test |
| 7 | Gate-manufactured findings: Chromium refuses its restricted ports (`ERR_UNSAFE_PORT`), and unset `VITE_*` keys put the literal string `undefined` into a third-party script URL. | first two live runs |

New mechanism: `tests/unit/tools/dispatch-repo-serviceability.test.ts` fails CI when
`DISPATCH_REPO_ALLOWLIST` contains a repo `deploy/agent-dispatch` does not sweep. Defect #1 cannot
recur silently. Proven to fail by removing the entry and watching it go red.

## Why

Seven of the loop's eight arrows were live and proven. The eighth — *look at the running product* —
did not exist, and the review protocol's honest response to that was to write **NOT VERIFIED: the
page renders** and clear the PR anyway. That is what happened on
`OplifyMessage/oplify-messaging-app#33`.

The recipe deliberately lives in FounderOS, not in the app repos. Two of the four dispatchable
repos belong to an employer; adding a Playwright config, a script and a devDependency there is a
change they must agree to and would appear as noise in every agent PR. It also removes the
dependency on Vercel's per-PR preview, which refuses agent-authored commits until a setting the
loop may not wait on is changed.

## Metrics

Measured on the VPS against `OplifyMessage/oplify-messaging-app`:

| Scenario | Result |
|---|---|
| Clean `main` | exit `0` — 4 page/viewport rows; login page rendered fully (screenshot confirmed) |
| `throw` in `src/main.jsx` | exit `1` — 4 blocking `page-error` rows naming the thrown message |
| Syntax error in `src/main.jsx` | exit `1` — `boot-build`, vite output attached, nothing rendered |
| Noise after tuning | 6 rows → 2, both genuine and pre-existing |

Two real, pre-existing, non-blocking defects found in the employer's app on the clean run: a
Razorpay checkout script requested with the literal string `undefined` in its URL, and a missing
`<h1>` on `/forgot-password`.

`pnpm gate`: **exit 0 · 407 test files · 4,542 tests passed.**

Daemon dry-runs after provisioning: `agent-dispatch` processes 4 repos, `pr-brain --list` sweeps 4.

## Outstanding

- **`npm test` is broken on `oplify-messaging-app`.** `--test-isolation=none` is Node 23+; the VPS
  runs Node 22.22.3, where the flag is `--experimental-test-isolation=none`. Pre-existing on `main`,
  not agent-caused. Every agent PR there gets a gate that cannot run the repo's own test command.
  One line, employer repo — a good first real `/task`.
- **Authenticated routes are not covered.** Needs a seeded test account and the API running
  alongside. The recipe shape allows it; the credentials do not exist.
- **The `pr-adversary` skill is unversioned**, living only in `~/.claude/skills/` on two machines.
  Editing it means editing both. No mechanism catches drift between them.
- **`GOOGLE_GENERATIVE_AI_API_KEY` is still world-readable in the VPS process table.** Unchanged
  from 2026-09-22.
