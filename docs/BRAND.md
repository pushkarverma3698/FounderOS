# Turicks Brand Guidelines

Full brand guidelines live at: `~/.claude/brand-guidelines/TURICKS.md`

This file is the in-repo pointer. All brand decisions, voice rules, and channel specs are authoritative in the global file.

## Quick Reference

**Positioning**: "AI-native agency that builds what others only prototype — 3–5 day delivery, working code not decks"

**ICP**: SME founders $50K–500K ARR in EU/US who need AI automation or a design-conscious software team

**Voice**: Direct | Specific | Confident | Practical | Partner (never vendor)

**Primary CTA**: "Book a Demo"

**Banned phrases**: "game-changer", "excited to share", "synergy", "I wanted to reach out", "Just following up", "Hope this finds you well" — see full list in global brand doc.

## Channel Word Limits
| Channel | Limit |
|---|---|
| LinkedIn posts | 150–300 words, max 3 emojis |
| Instagram captions | 80–150 words, max 3 emojis |
| Cold outreach | ≤150 words |
| Proposals | ≤500 words |

## Content Token Economy
- Batch 7 social posts per LLM call (stored in Redis 7-day TTL)
- Winning templates → turicks-brain → Ollama fill (free) on reuse
- Brand voice consistency → fewer revision loops → lower API spend

## Agent Critique Rules
See `governance/critique-rules.md` for the Brand Voice section that critique agents enforce at runtime.
