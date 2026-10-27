@AGENTS.md

# Claude-only notes

- Path-scoped detail loads from `.claude/rules/` when you touch matching files: `prod-vps.md`, `model-policy.md`, `docs-and-brain.md`, `video-factory.md`.
- Rules binding on Claude (full text and incidents: `docs/rules/CLAUDE-RULES-RATIONALE.md`):
  - #27 A rule with no mechanism decays: name the enforcing layer (CI, script, hook, nothing) and prefer CI.
  - #28 Approval authorizes work, it does not verify it. If an approved plan is wrong, say so before building.
  - #29/#33 Review is not delegable. A subagent's or other AI's claim is an input to verify.
  - #30 Before accepting a redirect, name the in-flight work it displaces.
  - #32 Review every Antigravity brief against `docs/antigravity/README.md` § "Before you dispatch".
  - #35 A PR verdict is stale once the head moves.
- Claude may merge to `main` when both required CI checks are green; never on red.
- Before a complex task, read the newest files in `docs/plans/` and query `turicks-brain` for recent sessions (cross-agent awareness).
