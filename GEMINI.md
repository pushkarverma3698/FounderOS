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

## Commands

```bash
pnpm test
pnpm lint
pnpm verify:arch
```

## Never

The list lives in [STANDARDS.md §11](docs/antigravity/STANDARDS.md) and is not repeated here — a
partial copy is how the four files this repo just consolidated drifted apart in the first place.
