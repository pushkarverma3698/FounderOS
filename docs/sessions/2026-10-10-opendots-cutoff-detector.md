# 2026-10-10/11 — OpenDots: loud cut-offs, phone token, team run

Branch `claude/chore-opendots-migration`, draft PR #1120 → `beta`. Follows `2026-10-10-opendots-team-v2-handoff.md`.

## Shipped (deployed to `/opt/opendots/deploy`, every file sha256-equal to the branch)
- `opendots-turicks.patch` (sha256 `fdfc05c4…`): `max_completion_tokens` 2200 → 16000, and a cut-off reply fails
  the turn (`RUN_ERROR max_tokens`) instead of ending "completed". OpenRouter reports a cut-off tool call as
  `finish_reason "tool_calls"`, so the check also reads `native_finish_reason` (`length`, `max_output_tokens`,
  `MAX_TOKENS`), `completion_tokens` reaching the cap, and tool arguments that do not parse.
- Web app keeps the owner token in `localStorage` (was `sessionStorage`).
- Chief prompt: a conflicting PR goes back with "the Builder merges the base branch in, never rebases".
- `.env.example` lists `AGY_SRC`, `TEAM_REPOS`, `SHIFT_SECONDS` (CI's env-example test caught them).
- OpenDots suite on the patched tree: typecheck exit 0, 49 files / 314 tests passed. Mutation: with the check
  disabled, the cut-off tests fail.

## Verified live
1. Direct jev-router calls: at 2,200 every model pick was cut off (deepseek: 2,200 tokens, all reasoning; gpt-6-luna,
   peer's run: 8,474 arg chars that do not parse). At 16,000 gpt-6-luna finished in 5,632 tokens; deepseek used all
   16,000 (12,567 reasoning) and still parsed — the detector fails that turn too (see risk below).
2. Sandbox #10: Builder PR 11 → Reviewer PASS → beta moved (PR 3 merged) → Chief refused the conflicting PR and sent it
   back → Builder merged beta in (`d531df26`, two parents, no force-push) → Reviewer approved again (16:39Z), CLEAN.
   The Chief merge did not run: see "Blocked".
3. Chief merged PR 3 (14:57Z) and closed #2 with a link. PR 5: Builder merged beta in, then the Reviewer blocked it at
   round 4 (its rule) and asked the founder.
4. Live view: a read-only subscriber on the Builder thread got the running turn's events as they happened.
5. 64 completed shifts (Architect 24, Builder 22, Reviewer 18): none ends mid-sentence; 0 cut-off failures fired live.

## Found
- **OpenRouter credits ran out ~20:47Z.** Account: $20 credits, $19.35 used. 200 shift runs since then failed with
  "maximum cost exceeds your available credits"; OpenRouter reserves `max_tokens` × price up front, so the 16,000 cap
  hits this wall sooner than 2,200 did. Failed runs cost nothing and retry every 15 min; they resume once credits exist.
- **Idle shifts spend money.** From 16:40Z to 20:47Z every shift was "No work", and Architect "No work" runs took up to
  240 s of tool calls. Each run replays the whole Shift conversation. Spend per shift is not measured (needs a
  management key).
- 8 runs failed on the hosted Intelligence platform (502 on lock/thread, "Thread lock denied", "history lookup
  failed"); the next shift retried each.

## Blocked
- Verification 2's last step (Chief merges PR 11, #10 closes) needs OpenRouter credits.
