# 2026-09-09 — Antigravity PR gate: #632 and #635 through to prod

## What we did

Adversarially gated both open Antigravity PRs and shipped them to `main` and prod.

- **#632** `fix(telegram)` — dead-link sanitizer, chunked fallback, alert-noise reduction.
- **#635** `feat(engineering)` — `dispatch_antigravity_task`, the HITL-gated producer for the VPS `agent-dispatch` loop.
- **#656** — merged the bot's `beta ← main` sync first, so `beta` stopped being 3 commits behind.
- **#661** — `beta → main` release; prod verified on `7f336f4`.

Both PRs carried a "GATE PASSED" comment from 2026-09-07. **That pass did not count**: both heads were 23 commits behind `main` by the time this session opened, and #635 was `CONFLICTING`. Every gate below was re-run on a tree merged with current `main`.

## What we fixed

**BLOCKER in #632 — the filename code-chip spliced `<code>` into URLs.**

The new step 2c in `src/gateway/format.ts` wraps a bare `name.ext` in a `<code>` chip so Telegram stops autolinking `.md`/`.py` as country TLDs. Its only guard was a `/` lookbehind, which does not reach a query string:

```
[JD](https://jobs.example.com/apply?file=brief.pdf)
  -> <a href="https://jobs.example.com/apply?file=<code>brief.pdf</code>">JD</a>
```

The pass added to *remove* dead links manufactured one. Fixed by extending the lookbehind to exclude `=`, `?`, `&` and `#` — the characters that precede a filename only inside a URL. Two tests added (`tests/unit/gateway/format.test.ts`); both fail on the pre-fix tree.

**Conflict in #635** — `docs/ROADMAP.md` and `docs/study/INTERVIEW-BRIEF.md` collided only on `verify:doc-claims`-managed numbers (`main` carried the 1,297 → 3,223 board expansion). Took `main`'s side, regenerated with `pnpm verify:doc-claims --fix`. No code conflict.

**Unreconciled counts in the #632 audit report** — flagged in-place rather than restated. The status breakdown sums to 73 against a headline of 68; the § 1 table sums to 96; the PR body claims 22 bracket leaks where the table lists 10 with 10 message IDs. The raw chat dump is (correctly) not committed, so they could not be re-derived. The doc now marks the **shapes** as the finding and the **magnitudes as unverified**. Every fix in #632 is justified by a shape, none by a count.

## Why

Two things this session is a record of, both worth not relearning:

1. **A gate verdict has a shelf life.** Both PRs were cleared on 2026-09-07 and both were stale two days later — one of them un-mergeable. A "GATE PASSED" comment is a statement about a tree, not about a PR. Re-check `git rev-list --count <head>..origin/main` before trusting one.

2. **`claims=0/1` in `agent-dispatch.log` is not a stuck queue.** It reads exactly like one — 0 of 1 candidates claimed — and it is the shape of this repo's most repeated defect (a subsystem wired to nothing). It is `claims=${claims_done}/${MAX_CLAIMS}` with `MAX_CLAIMS="${AGENT_DISPATCH_MAX:-1}"`: *zero claims against a cap of one per tick*, i.e. an empty `agent:ready` queue. Reading the script settled in one command what an hour of inference would have got wrong.

## Metrics

| Gate | Result |
|---|---|
| #632 merged with `main` | `pnpm gate` exit 0 — 376 files / 4121 tests |
| #635 merged with `main` | `pnpm gate` exit 0 — 378 files / 4117 tests |
| #632 + #635 combined | `pnpm gate` exit 0 — 378 files / 4134 tests |
| GitHub CI, all four PRs | green (type check + lint + wiring, unit + regression, gate) |

Prod, read directly after the deploy:

```
prod HEAD                7f336f4  (= origin/main)
ActiveEnterTimestamp     Tue 2026-09-08 19:24:58 UTC   (merge was 19:20)
sanitizeTelegramUrl      present
dispatch_antigravity_task present
format.ts lookbehind fix present
```

## Outstanding

1. **No live Telegram run for either PR.** Both are unit-proven end to end within the process; nobody has watched a real reply land or a real card get approved. `TELEGRAM_TESTER_API_ID`/`_API_HASH`/`_SESSION` are still absent, so MTProto QA cannot run headlessly.
2. **`dispatch_antigravity_task`'s `repo` argument is still caller-supplied**, taking precedence over `ISSUE_REPO`. Contained by the HITL card (the founder approves a *named* slug) and by the daemon's pinned crontab, but this agent reads untrusted text. Raised 2026-09-07, still an open founder decision: allowlist, or leave it.
3. **The `pr-brain` auth-notification storm is diagnosed, not throttled.** 1,590 repeats — over 21% of the entire chat history. The fix is a VPS crontab change, deliberately not made from a PR.
4. **The engineering prompt's authority change shipped.** FounderOS is no longer off-limits to the bot's own tooling; self-modification routes through `dispatch_antigravity_task`. Double-gated, but it is now live and should be a conscious position rather than a side effect.
5. No test pins "audit row only on a successful dispatch" in `src/agents/agent-tools/antigravity.ts`. The code is correct (early return before the write, read directly); the invariant is unpinned.
