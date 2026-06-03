# ADR-013: Keep `personal` and `engineering` as separate, scoped departments

- **Status:** Accepted (2026-06-03)
- **Supersedes:** nothing — reinforces ADR-010 (v2 ReAct office) and ADR-012 (personal department)

## Context
With the `personal` department live (laptop file/shell/browser ops, HITL-gated) alongside the
existing `engineering` department (GitHub read/write), the question arose: should `engineering`
*also* get laptop tools, or should `personal` be deleted and its tools folded into `engineering`
so one agent handles all "build / make things work" tasks?

Both departments ingest **untrusted content** — `engineering` reads GitHub issues/PR/repo text;
the office as a whole processes email/web. Prompt injection is in scope by design.

## Decision
**Keep them separate. Do not give `engineering` laptop tools. Do not delete `personal`.**

Each department holds only its own scoped tools:
- `engineering` → `github_read`, `github_write*` — cloud repo blast radius (recoverable via git).
- `personal` → `read_file`, `list_dir`, `write_file*`, `run_shell*`, `browser*` — local machine,
  confined to `$HOME` by `path-guard`, secrets blocked even on read.

(`*` = HITL-gated.) The supervisor holds **no** dangerous tools (only `read_context` /
`update_context`).

## Rationale (research-grounded, 2026-06-03)
- **Least privilege limits blast radius.** Merging would hand the most injection-exposed agent
  (`engineering`, which reads attacker-influenceable repo text) both `github_write` *and*
  `run_shell` on the founder's Mac — assembling the "lethal trifecta" (untrusted input + private
  data access + ability to act/exfiltrate) in one agent.
- **Separation of duties.** "Ship code to GitHub" and "run arbitrary commands on the laptop" are
  different trust domains and should not share one authority. (Microsoft CAF, OWASP AI Agent
  Security, Sophos blast-radius guidance.)
- **Tool-selection clarity.** Anthropic warns that piling tools onto one agent degrades routing.
  A 7-tool `engineering` agent spanning cloud + local mental models hurts determinism — and our
  eval already shows routing is sensitive to prompt surface.
- **"Start simple" still favors the split.** Anthropic's "fewer, consolidated tools" applies
  *within* a bounded domain, not *across* a trust boundary. Cloud-repo ops and local-machine ops
  are different domains.

## Cross-domain tasks: handoff, not key-sharing
When a task genuinely needs both (e.g. "clone the repo locally, run tests, then open an issue"),
the **supervisor orchestrates a sequential handoff** — `personal` does the local part, returns a
text result, then `engineering` does the cloud part. This is an emergent property of
`createSupervisor` (control returns to the supervisor after each sub-agent; it can route again in
the same thread). **No new code is required.** The result passes between departments as plain
text through the supervisor, never as shared tool access.

## Alternatives rejected
- **Give `engineering` laptop tools** — lethal trifecta on the most-exposed agent; rejected.
- **Delete `personal`, fold into `engineering`** — same over-provisioning plus worse tool
  selection; rejected.

## Consequences
- Architecture stays at 7 scoped departments; no code change from this decision.
- A future multi-step workflow primitive (explicit planned handoffs) remains possible but is
  **not** built now — YAGNI until a real cross-domain task demands more than supervisor sequencing.
- **Follow-up (verification gap):** the golden eval only covers single-department routing. A 2-hop
  `personal → engineering` chain is expected to work but is not yet asserted. Tracked as a
  candidate eval case, not a blocker.
