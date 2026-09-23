# 2026-09-23 — The Telegram surface becomes tappable

## What we did

Replaced the two places the founder has to *remember and retype* with buttons.

1. **`/task` no longer needs the `repo:` syntax.** `/task <what you want>` now answers with a
   row of repo buttons. Tapping one dispatches, using the founder's untruncated original
   message — which travels on `reply_to_message`, not in a server-side map. A bare `/task`
   asks for the repo first, then asks what to build with `force_reply`, and the chosen
   repository travels back on the prompt's own `Repo:` line. **Neither flow stores anything
   between messages**, so a restart mid-flow loses nothing.
   `/task repo:hulda <work>` still works unchanged for anyone who prefers typing.

2. **`/start` and `/commands` became a four-face screen.** Home → Build / Jobs / System, each
   tap editing the message in place rather than appending. The engineering section is written
   as *what happens* — the seven numbered stages, including the two that post to the chat —
   rather than as a command list.

3. **The ☰ menu reordered.** The eleven `wife_` twins moved below the singletons in the
   `setMyCommands` payload. Nothing was dropped; read order among the founder's own commands
   is unchanged and still pinned by test.

## What we fixed

| # | Defect | Evidence |
|---|---|---|
| 1 | **`/task app fix the login` silently dispatched to FounderOS** with the stray word still in the brief. `repo:` is the easiest part of the command to forget, and forgetting it cost a real Antigravity run against the wrong repository to discover. | `parseTaskArgs` now returns `needs-repo`; `task-command.test.ts` pins both the target and the preserved text |
| 2 | **`/task` at position 23 of 33** in the ☰ menu, under 22 job commands of which 11 were near-identical `wife_` rows. Telegram shows ~8 rows at a time on a phone. | measured against the live bot via `getMyCommands`; now 12, pinned by `command-menu.test.ts` |
| 3 | **`/start` was a 48-line wall** naming 20 commands — a screen you read once and cannot act on without scrolling back and retyping. | `buildWelcomeMessage` now delegates to `buildMenuSection("home")`; one copy, not two |
| 4 | **Every callback except `approve`/`reject` answered "Unknown action".** The inline-keyboard infrastructure existed and was used for exactly one thing. | prefix-routed in `telegram.ts`; the HITL path keeps its exact previous behaviour, pinned by test |

## Why

The 2026-09-23 verdict on the previous release was *"I am unable to see the improved UI or UX."*
He was right, and the copy was not the problem. Reading a long message, holding one command out
of 33 in your head, and typing it back with exact syntax is three independent chances to drop the
thread. The ☰ menu that was supposed to close that gap had the new commands below the fold twice
over.

Rule #26 applies directly: a capability that is documented, registered, deployed and still
unreachable has not shipped. **Nothing on the new home screen has to be typed to be reached.**

Two design constraints worth keeping:

- **Callback data is external input.** `repoFromCallbackData` and `repoFromPrompt` both
  re-resolve through `matchAllowlistedRepos` rather than trusting the value. The allowlist is
  the only thing between a malformed dispatch and every repository the VPS token can write to.
- **The conversation is the state.** Two flows need to remember something across messages and
  neither uses a map keyed by chat id — the work rides on `reply_to_message`, the repo rides on
  a visible `Repo:` line. There is nothing to expire, leak, or get wrong on restart.

## Metrics

- `pnpm gate` → **exit 0**, 415 test files, 4,667 tests (`/tmp/gate-ux-13000.log`, 2026-09-23).
  Baseline on `main` before this branch: 413 files / 4,611 tests.
- New: `src/gateway/repo-picker.ts` (177 lines, PURE), `src/gateway/home-menu.ts` (207 lines).
- New tests: `repo-picker.test.ts` (21), `home-menu.test.ts` (17), plus 9 added to
  `task-command.test.ts` and 4 to `command-menu.test.ts`.
- `/task` position in the native menu: **23 → 12** of 33.
- `/start` length: 48 lines → 16, with the rest one tap away.

## Outstanding

- The `force_reply` flow (bare `/task` → tap repo → reply with the work) is unit-tested but has
  **not** been driven through a real Telegram client. It is the one path where Telegram's own
  behaviour — whether the reply arrives with `reply_to_message` populated — is assumed rather
  than observed.
- `UI QA` has been red on `main` since 2026-09-16 (vision verdicts on cinematic preset scaffold
  copy). Still not a required check, still a content decision.
