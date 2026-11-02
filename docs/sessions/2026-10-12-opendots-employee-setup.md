# 2026-10-12: OpenDots computers set up like an employee's laptop

## Outcome
Every OpenDots computer (Chief, Architect, Builder, Reviewer) now has the founder's engineering rules, four skills
and the shared brain, installed from the repo by `deploy/opendots/setup-dots.sh`. The Chief Dot answers calendar,
mail and memory questions through a `turicks-brain` Connection.

## What shipped
- #1130 → main via #1131: `src/mcp/hub-http.ts`, the hub over Streamable HTTP with bearer auth, as
  `founderos-hub-http.service`. It binds `172.21.0.1:3100` (the `opendots-computers` bridge gateway), with a ufw rule
  admitting that subnet only. It has two tokens: the full one for all 9 tools, and a brain-only one for the 5 memory tools.
- #1132 (draft to beta): `deploy/opendots/home/` (CLAUDE.md + 4 skills), the setup-dots install, the Chief
  Connection, and the team-shift brain reads.

## Decisions
- Computers hold only the brain-only token. Repo code runs as root in them, so anything placed there is readable.
  The full token lives only in the OpenDots SQLite, as the Chief Connection.
- Shifts may only read memory: issue and PR text is untrusted input.
- Founder chose "split PR, I promote": the hub PR is merged and promoted by Claude, and the employee setup is a draft PR.

## Proof (live, 2026-10-12)
- `claude -p` in all 4 computers quoted a CLAUDE.md rule, named `production-ready`, and returned a real
  `search_memory` hit.
- The Chief, asked "what's on my calendar today?" through `od-say`, called `calendar_events` and answered from its result.

## Open
- agy has no brain MCP. The Builder's `~/.gemini/config/mcp_config.json` still has a dead stdio entry.
- Oplify CLAUDE.md in the Oplify clones waits for the new GitHub PAT.
- Architect agy login waits for the founder's `dot-login agy start` tap.
- Gotchas: after a computer image rebuild, stop and start each computer through the API. After `install.sh`, re-copy
  `/tmp/od-chat.mjs` and `/tmp/od-hist.mjs` into `app-app-1`.
