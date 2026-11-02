# 2026-10-11 — OpenDots: the Dots dispatch, claude works (team-shift)

Branch `claude/chore-opendots-migration`, PR #1120 (commits 39377b26, de8c5465). Deployed to `/opt/opendots`.

## Why
OpenRouter credit went from ~$9 to ~$0.65 on 10-10 between 14:04Z and 20:47Z. The cause was the Dots, not FounderOS
($0.05). Each Dot did the engineering itself with gh/git/file reads under a 150-step limit (Builder: 358 shell calls,
27 of them claude), and every step re-sent the whole run to the paid model.

## What changed
- `deploy/opendots/team-shift <role>`: one shell call per shift. It reports or collects the role's claude run, else claims
  the oldest queued item, clones/fetches the repo and starts `claude -p` inside the clone (run-bg) with the
  `team/<role>.md` brief and a per-role tool allowlist. Code guards: a claim not handed over, a failed run or a run over
  90 min → blocked with the last output; a lost run restarts; a 4th review round blocks.
- The Dot prompts now just run `team-shift` and report. Patch: a 12-model-call limit replaces `maxIterations(150)`.

## Learned
- `claude -p` permissions cover only its working directory: `cd elsewhere && git ...` or `git -C` needs an approval
  that `-p` cannot get. Start claude inside the repo (first live Builder run blocked on exactly this).
- `gh issue list --label` can miss an issue created a second earlier; the next shift picks it up.
- Smaller prompts also cleared the 402 "maximum cost exceeds credits" (the reservation is prompt + 16k output).

## Proof
Sandbox #13 → plan → draft PR #14 → Reviewer PASS + `agent:approved`, ~2.5 min of claude time. Allowlist probes:
merge, Architect push, `gh api`, force-push all denied. Dot shift: 1 tool call, 9 s, $0.0018.

## Open
Idle shifts still cost ≈ $0.50/day at 15-min intervals. Credits $0.64 left. A full Dot-driven start → collect cycle
has not run live yet.
