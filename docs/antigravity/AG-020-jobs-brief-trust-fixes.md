# AG-020 — Job brief: commands hit the right queue, section labels tell the truth

**Plan:** [2026-10-04 Telegram UX audit](../plans/2026-10-04-telegram-ux-audit.md), tasks P0-1 and P0-5.
**Branch:** `task/issue-<N>-jobs-brief-trust-fixes`, cut from a fresh `origin/beta`. PR base: `beta`.
**Moves:** C. The paths sit under `src/tools/jobhunt/`, which is frozen, so the PR needs the `unfreeze`
label. **Do not dispatch until the founder has approved the unfreeze.**
**Status:** draft, not dispatched.

**Read [STANDARDS.md](STANDARDS.md) in full before writing any code. It is binding.**

---

## Goal

When Tashi reads her brief in the jobs group, every command it prints acts on **her** queue, and
every section heading describes the rows under it.

## Problem (observed in prod, 2026-09-28 → 10-02)

1. **Commands hit the wrong queue.** Tashi's `/wife_today` brief ends with "▶️ DO THIS NEXT
   `/draft 1` — apply to Nexperia". A bare `/draft 1` resolves to the **default profile**, which is
   Pushkar's queue (`src/gateway/jobhunt-profile-arg.ts`). `renderNextActions`
   (`src/tools/jobhunt/brief-actions.ts:72`) prints `/draft N`, `/ask N` and the HOW TO APPLY
   example with no profile selector. Its only caller is `brief.ts:362`. The per-row command hints
   come from `renderMarketBlocks(rows, "/draft", …)` at `brief.ts:253, 268, 284, 299`, and they
   have the same defect. #784 already fixed pushed alerts with `profileSelector()`
   (`profile-config.ts:311`); the brief was left out.
2. **The NOT LAWFUL section holds rows that aren't legal bars.** In `brief.ts:306`,
   `unlawful = rejected.filter((r) => !isTooSenior(r))`, and `isTooSenior`
   (`brief-sections.ts:217`) checks only the `Experience` gate. So a `Level` rejection such as a
   "staff seat" lands under "⛔ NOT LAWFUL — A legal bar, not a preference", and so do
   `Language`, `Pay` and `Location` rejections. The candidate reads that as "you are not allowed
   to work there".

## Expected behaviour

1. A brief rendered for a non-default profile prints `/draft tashi 1`, `/ask tashi 1` and
   `/applied tashi 1`, using whatever token `profileSelector()` returns. A brief for the default
   profile is unchanged, byte for byte.
2. Rejected rows split by their rejecting gate:
   - **⛔ NOT LAWFUL** holds only rows rejected by `Basis` or `Sponsor`;
   - **🚫 NOT YOUR LEVEL** holds rows rejected by `Experience` or `Level` (rename the existing TOO
     SENIOR / TOO JUNIOR section);
   - **➖ OTHER BARS** holds everything else, and each row names its gate.

## Measured starting state — check before you begin

- Run `grep -n "renderNextActions(" src` and expect exactly 1 call site, `brief.ts:362`.
- Run `grep -rn 'gate: "' src/tools/jobhunt/*.ts` and expect these gate names: Basis, Check,
  Experience, Language, Level, Location, Pay, Posting, Sponsor. If the set differs, stop and report
  it.
- `brief.ts` has 370 lines and the cap is 400. If the change pushes it over, move the reject-section
  rendering into `brief-sections.ts` (315 lines).

## Files in scope

`src/tools/jobhunt/brief.ts`, `src/tools/jobhunt/brief-actions.ts`,
`src/tools/jobhunt/brief-sections.ts`, plus their tests under `tests/unit/jobhunt/`.

## Constraints

- Add a profile selector parameter to `renderNextActions` and `renderMarketBlocks`, and thread it
  in from the brief's profile. Do not re-resolve the profile from text.
- Do not change the row numbering. Stable IDs are a separate task (P0-2).

## Explicitly forbidden

- No changes to screening, gates or verdicts. This task changes rendering only.
- No changes outside the files in scope.
- No LLM calls.

## Verification commands

```bash
pnpm test tests/unit/jobhunt
pnpm lint && pnpm verify:arch
```

## Acceptance criteria

1. A new unit test fails on `beta` and passes on the branch: a brief rendered for
   `wife-nl-finance` contains 0 matches of `/(draft|ask|applied) \d` without a profile token.
2. A new unit test: a row rejected only by `Level` renders under NOT YOUR LEVEL, not NOT LAWFUL.
3. The default-profile brief snapshot is unchanged.
4. Real path, after deploy: send `/wife_today` in the jobs group and read the reply over MTProto
   (`scripts/telegram-probe.ts`). DO THIS NEXT shows `/draft tashi 1`.
