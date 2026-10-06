# 2026-10-06 — coding pipeline wave 3 build (all behind AGENT_PIPELINE_V2=1)

## What we did
Built wave 3 of the thin slice as six stacked draft PRs, one slice each, plus one chain test. Nothing is merged; every PR carries `Moves: A`.

| Slice | PR | What it does |
|---|---|---|
| A | #932 | files coding asks as `agent:spec`, ask verbatim |
| P | #933 | Pass P writes the contract and the locked test, commits it, sends the spec card |
| GW | #934 | `cp:` button handler: Approve / Change / Cancel / Merge, writes `merged_sha` |
| I | #935 | the executor of an approved spec gets a contract prompt on the spec branch |
| EV | #936 | a reviewed PR with an approved contract gets an evidence card instead of an auto-merge |
| J | #938 | after a deploy, one message says what each merged task's oracle saw on prod |
| chain | #940 | one offline test drives intake → spec → approve → executor → evidence card → merge → report |

Stack: #926 (pending store) → A → P → I → EV → J → chain. GW is a sibling of #926; the chain branch merges it in.

## What we fixed
- EV: pr-brain's carry-forward merge path would have bypassed the card. All merges now go through `merge_or_card`; a structural test pins that `merge_cleared` is called only there.
- J: the existing deploy-workflow test reads each step as "from its `- name:` to the next one", so a comment placed above a new step landed in the step before it. The comment now sits inside its own step, and two tests pin the report step.

## Why
The chain test exists because slice tests do not prove the seams. It checks that the fingerprint Pass P records is the one Approve checks, that the contract Approve stores is what the executor prompt and the evidence card read, that the merge sha the Merge tap writes is the one the report selects, and that a moved head or a spent card stops the chain. Three seam mutations (no `merged_sha`, stale head ignored, no spec commit) each fail it.

## Metrics
- chain: 6 tests; unit suites 262 files, 3499 passed; scripts suite at the macOS baseline of 12 failures (midrun 1, down-state 1, pr-brain-notify 2, pr-brain-token 5, tg-quiet 3) — same on main.
- Zero paid calls.

## Outstanding
Live path NOT VERIFIED anywhere: `claude-agent` does not exist on the VPS, so Pass P's run, the executor run, pr-brain's card call and the deploy step have not run for real.
Founder actions: create the `claude-agent` user and `/login`; sudoers line and `/var/lib/claude-agent/spec-work`; contracts-dir write access for the bot, dispatcher, pr-brain and deploy users; `ORACLE_ALLOWED_HOSTS`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` in the VPS `.env`; set `AGENT_PIPELINE_V2=1` only after the whole chain is on prod.
AG-023 (#923) may add one registration line to `src/gateway/telegram.ts` (399 of 400 lines); whichever lands second rebases.
