# Turicks Engineering Case Studies

> How we built an autonomous agent system, watched it rot from the inside, and rebuilt it into something we'd stake production on. Written candidly — including the parts where we were the problem.

Turicks builds AI-native software. FounderOS is the system that runs the studio: you send it a task over Telegram, and it takes real business actions — email, LinkedIn, GitHub, shell — with your approval and a receipt for every one. It is also the most honest teacher we've had, because we shipped it three times before we shipped it right.

These case studies trace the journey **v1 → v2 → v3**. The recurring theme is not "AI is bad at coding." It's the opposite: AI coding agents are *fast*, and speed with no discipline compounds into **AI slop** — plausible, confident, over-engineered code that passes review and fails production. Each study is one place we fell into that trap, and the specific mechanism we used to climb out.

Every number and trace below is real, drawn from our own audit trail (`ZERO-BASE-AUDIT.md`, `JARVIS-ARCHITECTURE.md`, the ADR log, and git history).

## The studies

| # | Title | The pivot |
|---|-------|-----------|
| [01](01-three-router-trap.md) | **The Three-Router Trap** | Three competing control systems fighting over every message → one typed plan, dispatched by pure code |
| [02](02-lie-detector-for-our-own-ai.md) | **The Lie Detector We Built for Our Own AI** | A 591-line, 77-regex "did the AI actually do it?" guard → receipts that make lying structurally impossible |
| [03](03-empty-braces-handoff.md) | **Empty Braces: The Handoff That Lost the Task** | `transfer_to_dept({})` and prose round-trips → a typed `TaskEnvelope` at every boundary |
| [04](04-when-recovery-meant-data-loss.md) | **When "Recovery" Meant Data Loss** | Fail-open catches and a cleanup path that wiped the founder's work → typed failures that name the real component |
| [05](05-working-with-ai-agents-without-slop.md) | **Working With AI Coding Agents Without Drowning in Slop** | The playbook: how we let an AI agent write most of this code without letting it bloat the codebase |

## How to read them

If you only read one, read [05](05-working-with-ai-agents-without-slop.md) — it's the playbook the other four earned. If you want the war stories that justify the playbook, read [01](01-three-router-trap.md) through [04](04-when-recovery-meant-data-loss.md) in order.

Each follows the same shape: **The Genesis (v1)** → **The Bloat & AI Slop (v2)** → **The Production Reality (v3)** → **Key Engineering Takeaways**, opening with a stats box and a "what it cost us / how we got out" beat.

## See also

- **[The Turicks blog](../turicks-blog/)** — the shorter, opinion-led companions built to travel (Hacker News, LinkedIn), with a ready-to-post [LinkedIn kit](../turicks-blog/linkedin-kit.md) for every case study and post.
- **[The diagrams](../diagrams/)** — the whole v3 system drawn, including a [v2 vs v3](../diagrams/09-v2-vs-v3.md) side-by-side.
