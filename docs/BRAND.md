# Turicks Brand Guidelines

Full brand guidelines live at: `~/.claude/brand-guidelines/TURICKS.md`

This file is the in-repo pointer. All brand decisions, voice rules, and channel specs are authoritative in the global file.

> **Updated 2026-06-17:** Repositioned per ADR-033 — The Autonomous Studio.

## Quick Reference

**Positioning**: "The Autonomous Studio — AI-native creative + delivery for funded AI/dev-tool startups. We design the launch experience. FounderOS runs governed, audited delivery."

**ICP**: Funded AI / dev-tool startups (Seed–Series A) needing a launch experience that proves cutting-edge — not generic SME founders.

**Team reality**: Effectively solo — founder executes + learns design craft. (Stale "7-person team" copy retired.)

**Voice**: Direct | Specific | Confident | Practical | Partner (never vendor)

**Primary CTA**: "Book a strategy call" / "See our proof work"

**Pricing floor**: $8K project / $5K-mo retainer. **$500 starter retired** (commodity signal).

**Banned phrases**: "game-changer", "excited to share", "synergy", "I wanted to reach out", "Just following up", "Hope this finds you well" — see full list in global brand doc.

## Channel Word Limits
| Channel | Limit |
|---|---|
| LinkedIn posts | 150–300 words, max 3 emojis |
| Instagram captions | 80–150 words, max 3 emojis |
| Cold outreach / Proof Drops | ≤150 words |
| Proposals | ≤500 words |

## Moat narrative (use in all outbound)

> "Beautiful product, shipped by an AI studio you can trust and watch."

FounderOS proof points: HITL on every external action, eval harness, idempotent audit log, 1,098 tests green.

## Content Token Economy
- Batch 7 social posts per LLM call (stored in Redis 7-day TTL)
- Winning templates → turicks-brain → Ollama fill (free) on reuse
- Brand voice consistency → fewer revision loops → lower API spend

## Agent Critique Rules
See `governance/critique-rules.md` for the Brand Voice section that critique agents enforce at runtime.

## Strategy docs
Full GTM strategy: [docs/strategy/README.md](strategy/README.md)
