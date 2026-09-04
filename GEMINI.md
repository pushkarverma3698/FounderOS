# FounderOS — Gemini Instructions

FounderOS is a deterministic agent kernel with a Telegram gateway.

## Precedence

```text
1. Founder instruction in chat                  ← always wins
2. CI fitness rules (verify-architecture.ts)    ← the only BINDING layer
3. docs/antigravity/STANDARDS.md                ← how code is written
4. CLAUDE.md / AGENTS.md / GEMINI.md            ← role-specific operating instructions
5. Everything else                              ← reference
```

A rule which is not enforced by layer 2 is a convention, and a rule that is enforced cannot be satisfied by argument.

- **Binding coding standard:** [docs/antigravity/STANDARDS.md](docs/antigravity/STANDARDS.md). You must read it in full before writing code.
- **Delegation contract & brief index:** [docs/antigravity/README.md](docs/antigravity/README.md).

## Grounding & Memory-First Reasoning

- Reason strictly over repo data, DB memory (`founder_context`, `turicks-brain`, `failure_lessons`), and live code.
- Never use ungrounded generic world assumptions to overcomplicate tasks.

## Experience & Outcome Over Code Purity (⚠️ NON-NEGOTIABLE)

- The primary metric for FounderOS is **Founder Friction Saved & Real-World Outcome Quality**—not abstract code aesthetics or theoretical refactoring.
- Every self-improvement cron and audit must analyze 3 days of real turn transcripts, user feedback, hallucination signatures, and execution friction, storing findings into `failure_lessons` and `turicks-brain`.

## Commands

```bash
pnpm test
pnpm lint
pnpm verify:arch
```

## Never

The list lives in [STANDARDS.md §11](docs/antigravity/STANDARDS.md) and is not repeated here — a
partial copy is how the four files this repo just consolidated drifted apart in the first place.

## Branching

One branch per unit of work, cut fresh from `origin/main`, PR'd to `beta`. The rules —
naming, lifetime, merge targets, and the narrow hotfix exception — live in
[BRANCHING-STRATEGY.md](docs/antigravity/BRANCHING-STRATEGY.md) and are **binding on you**,
not just on Claude. Same reason as above: pointer, not a partial copy.

Branch **before** the first edit. Never leave unrelated work sitting uncommitted on `main`.

Name it `<type>/<slug>` (`feat` `fix` `hotfix` `chore` `docs` `refactor` `test`), or
`antigravity/<type>-<slug>` when your harness owns the prefix. The slug is 2–5 lowercase kebab
words naming the *subject*. **A harness codename is not a name** — rename before the first push
(`git branch -m fix/short-subject-slug`). `pnpm verify:branch`, inside `pnpm gate`, fails a
malformed one, so a bad name blocks your own gate before it ever reaches review.

## End-of-session handoff (ALWAYS)

**Automated Brain Sync:** If you created, modified, or deleted any file in the `docs/` directory during your session (including plans, architecture, or rules), you MUST autonomously run `pnpm brain:sync` in the terminal before concluding your task. Do not wait for the founder to do this.

## Shared directives (binding, single copy)

Four directives apply to every agent in this repo and are **not repeated here** — restating them
is how they drift:

1. **Strategic Mandate** — ship revenue-moving work over internal refactoring
2. **Content Generation (No AI Slop)** — the `no-ai-slop` skill is mandatory for anything public
3. **Implementation Plans & Memory** — plans go to `docs/plans/YYYY-MM-DD-feature-name.md`
4. **Cross-Agent Awareness** — check `turicks-brain` + recent `docs/plans/` before complex work

Full text, with the reasoning for each: [docs/rules/SHARED-DIRECTIVES.md](docs/rules/SHARED-DIRECTIVES.md). Read it before your first substantive action.
