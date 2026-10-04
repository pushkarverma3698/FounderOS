# 2026-10-04 — audit of the 10-03/04 merges

Audited #803, #813, #819, #824, #825, #826, #832, #833, #834 against code and prod. Shipped:

- #837: dispatcher slug cut-then-trim (trailing hyphen lost #834's PR, #831 went `agent:failed`).
- #836: agent setup and pipeline audit (`docs/plans/2026-10-04-agent-setup-and-pipeline-audit.md`), AG-022 brief.
- #838: /login paste detection and `/login cancel`; ❔ for agy rows never checked live; forced engine kept across the
  HITL resume; profile word and `/ask` in brief overflow notes; rejection card lists steps that already ran; /tasks keeps
  `behind`/`blocked` PRs off "ready".

## What was learned
- Gated tool bodies re-run on resume. Anything the gateway forces (engine, profile) must also reach the resume config,
  not only the first invoke.
- A pending conversational state (login, wizard) that eats every message is a trap. Gate it on the input's shape and
  give it a cancel.
- `mergeable_state` can be `behind` with green CI; "green" is not "mergeable".
- The suspected /remind → planner → /remind loop did not reproduce live (set in 7 s). Model-dependent; keep watching.

## Open (not fixed)
- Bot handles one Telegram update at a time (`bot.start()` sequential); a slow handler freezes every chat. Task chip filed.
- Planner writes "Ran /cmd" into history before the tap; wife cannot tap `cmd:` cards outside the primary chat.
- `*_FALLBACK_MODELS` provider typo crashes boot; empty var silently means no fallbacks (#832).
- Dispatcher PR lookup should fall back to head prefix `task/issue-<N>-`.
- Gmail/Calendar `invalid_grant` in prod: founder runs `/login google <profile>`.
