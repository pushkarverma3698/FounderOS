# App QA node — the last arrow in the dispatch loop

**How a pull request gets its application started, rendered and photographed before anyone merges
it.** Read with [UI-QA-CONTRACT.md](UI-QA-CONTRACT.md) (the same evidence pack, applied to static
scaffolds) and [ISSUE-DRIVEN-CONTRACT.md](ISSUE-DRIVEN-CONTRACT.md) (how a defect becomes a PR).

## The gap this closes

The loop had seven working arrows and one missing one:

```
/task → issue → Antigravity implements → draft PR → pr-brain gates → re-dispatch → verdict → merge
                                                          ▲
                                          nothing here ever STARTED the product
```

`pnpm gate` proves the TypeScript compiles and the units pass. The adversarial audit reads the
diff. Neither opens the app. On a front-end repository the protocol's honest answer was to write
**NOT VERIFIED: the page renders** in the review body and clear the PR anyway — which is what
happened on `OplifyMessage/oplify-messaging-app#33`.

## What runs

```bash
pnpm qa:app --dir /opt/review/oplify-messaging-app                  # boot, render, report
pnpm qa:app --dir <checkout> --out .artifacts/app-qa                # + report.md/json + PNGs
pnpm qa:app --dir <checkout> --changed-from origin/main             # skip when the diff is irrelevant
pnpm qa:app --dir <checkout> --vision                               # + the paid visual review
```

| Stage | What it does | Cost |
|---|---|---|
| **Boot** | `npm ci` → `npm run build` → serve on a loopback port, poll until it answers | $0 |
| **Measured** | Renders each public route at desktop + mobile: placeholders, uncaught errors, failed assets, blank pages, overflow, invisible sections, missing headline | **$0** — no model call |
| **Visual** (`--vision`) | One Gemini call per screenshot: overlapping text, unreadable contrast, broken layout | paid, capped |

### Exit codes are THREE, not two

| | Meaning |
|---|---|
| `0` | the app booted and nothing blocking was found |
| `1` | blocking defects — **or the app could not be built or started at all** |
| `3` | not applicable: no recipe for this repo, or the diff touches nothing it covers |

A third code exists because `0` would make *this gate did not run* look exactly like *this gate
found nothing*, and `pr-brain` has to tell those apart to decide whether the review may claim
browser verification at all. That collapse is the did-not-run-reads-as-clean failure
`src/evolution/run-audit.ts` and the `render-failed` row both already exist to prevent.

## Recipes live here, not in the app's repository

`src/tools/browser/app-recipes.ts` holds, per repository: install, build, start, port, ready path,
public routes, trigger paths, env, and the dependencies this gate knowingly does not provide.

Two of the four dispatchable repos belong to an employer. Adding a Playwright config, a `test:e2e`
script and a devDependency to someone else's repository is a change they have to agree to, review
and maintain — and it would arrive in every agent PR's diff as noise. Keeping the recipe on our
side means the employer's repo is untouched and a changed start command costs one line here.

It also removes the dependency on a per-PR preview deployment. Vercel refuses to build
agent-authored PRs on `oplify-messaging-app` until its commit-author check is changed, which is a
decision the loop may not wait on. Booting the checkout ourselves needs nobody's permission.

**Adding a repository** = one entry in `APP_RECIPES`. Until then that repo's PRs get an exit `3`
pack saying so by name, never a silent pass.

## Coverage is printed on every run

`routes` is the **public** surface. `oplify-messaging-app` puts its real screens behind a login,
and a gate that navigates to `/dashboard` with no session measures the login page twice and reports
two clean rows — a pass that checked nothing. Every pack therefore opens with the recipe's
`authNote`, naming the screens that were **not** looked at.

A review that quotes a pack's ✅ without its coverage line has laundered a narrow check into a
broad claim.

## Expected-missing dependencies are re-labelled, never dropped

The gate starts no backend and holds no third-party credentials, so the API refuses every
connection and Google answers 403 to a placeholder client id. Left alone those are 3–4 red rows on
**every** pull request, and a gate that is noisy on every PR is a gate everyone scrolls past.

`annotateExpectedExternal` rewrites them to `low` carrying the recipe's own sentence about what
that leaves unverified. Two rules keep it honest:

- Only `failed-asset` and `console-error` are downgraded. An **uncaught exception stays HIGH** even
  when it names the offline backend: an app that throws instead of handling a failed request is
  broken for any visitor whose network hiccups. That is the most valuable finding this node makes.
- Nothing is removed. A defect deleted from a report is a defect nobody can disagree with.

## Where it binds

`pr-brain` runs the app gate **before** dispatching the reviewer and posts the pack as one PR
comment marked `<!-- app-evidence -->`, updated in place. The reviewer then *reads evidence*
instead of being told to go and produce it — CLAUDE.md rule #27: CI-enforced rules drifted zero
times in a month, markdown rules drifted three times in a day. The `pr-adversary` step 6b is the
weaker half of this pairing; the artifact on the PR is the stronger half.

Up to **two screenshots per gated head** are sent to Telegram. Text cannot answer "does it look
right", and that question was the whole reason this node was asked for. Two, not all of them: the
2026-09-08 audit found `pr-brain`'s unthrottled notifications had taken 21% of the entire Telegram
history, and a photo costs more attention than a line of text, not less.

## Verified

Measured on the VPS against `OplifyMessage/oplify-messaging-app`, 2026-09-23:

| Scenario | Result |
|---|---|
| Clean `main` | exit `0` — 4 page/viewport rows, login page rendered fully (screenshot confirmed) |
| `throw` added to `src/main.jsx` | exit `1` — 4 blocking `page-error` rows naming the thrown message |
| Syntax error added to `src/main.jsx` | exit `1` — `boot-build`, vite output attached, nothing rendered |

The clean run also found two real, pre-existing, non-blocking defects in the app: a Razorpay
checkout script requested with the literal string `undefined` in its URL, and a missing `<h1>` on
`/forgot-password`.

## Not in this milestone

- **Authenticated routes.** Needs a seeded test account and a backend, which means running the API
  repo alongside the app. The recipe shape already allows it; the credentials do not exist.
- **Failing the merge on a blocking pack.** The reviewer weighs it today. Making exit `1` block
  automatically should wait until the gate has been wrong at least once and we know how.
