---
name: turicks-brand-guidelines
description: Comprehensive brand identity, voice, channel rules, and token economy rules for Turicks AI agency — loaded by Claude for all Turicks/FounderOS work
metadata:
  type: reference
  version: "1.0"
  last_updated: "2026-06-17"
---

# Turicks — Brand Guidelines

## 1. Brand Identity

| Field | Value |
|---|---|
| **Name** | Turicks |
| **Tagline** | "The Autonomous Studio" |
| **Internal positioning** | "AI-native studio for AI/dev-tool startups — governed delivery on FounderOS, cinematic design finish" |
| **Mission** | Ship cinematic launch experiences for AI-native startups — beautiful, audited, watchable |
| **Website** | https://turicks.com |
| **Type** | AI-native software agency (personal → SaaS operating model) |

---

## 2. Brand Architecture (Product Hierarchy)

```
Turicks (agency brand)
├── FounderOS           — internal AI OS running all ops (personal-use first, SaaS second)
│   ├── Departments: research | comms | engineering | marketing | sales | personal | jobhunt
│   └── Gateway: Telegram (now) → own web app (next)
├── turicks-brain       — knowledge DB + context store (Postgres + pgvector)
│   └── Source of truth for all brand records, case studies, operational decisions
├── Website Builder     — inhouse tool, separate domain, SaaS product on turicks.com
└── turicks.com         — agency site + product marketplace
```

**Key rule**: turicks-brain is for brand/ops data only. personal-rag is Pushkar's personal career DB — never mix them.

---

## 3. Ideal Customer Profile (ICP)

- **Who**: Founders of AI-native or dev-tool startups (seed–Series A)
- **Where**: Global, English-first
- **Pain**: Launch site looks generic; investors/users don't feel the product is cutting-edge
- **Need**: Cinematic launch experience + governed delivery (not vibe-coded slop)
- **Decision trigger**: Funding round, product launch, rebrand, or failed agency that delivered decks

---

## 4. Pricing

| Tier | Price | Description |
|---|---|---|
| Cinematic Launch Experience | $8,000+ | DFY landing + copy + deploy (cinematic-web) |
| Retainer | $5,000/mo | Ongoing site iterations + content |
| Gumroad packs | $14–34 | Passive digital products |

**Retired:** $500 starter (commodity signal — see ADR-032).

**Positioning**: Premium, outcome-based. Never compete on cost. Frame as ROI, not expense.

---

## 5. Services

1. AI Agents & multi-agent systems (LangGraph, FounderOS)
2. Full-stack SaaS development (Next.js, Node.js, TypeScript)
3. UI/UX design + design systems
4. Cloud infrastructure + DevOps (AWS, Docker, Kubernetes)
5. Business automation workflows
6. Mobile development (iOS / Android / React Native)
7. Enterprise AI integration

---

## 6. Voice & Tone

| Principle | Do | Don't |
|---|---|---|
| **Direct** | Lead with the prospect's problem | Lead with our capabilities |
| **Specific** | "We cut your lead qualification time by 60% using LangGraph agents" | "We use AI to optimize your processes" |
| **Confident** | Authoritative, matter-of-fact | Hedging, over-qualifying |
| **Practical** | "Working code, not decks" | Buzzword-heavy |
| **Partner** | "your on-demand product engineering team" | "vendor", "service provider" |
| **Outcome-first** | "Book a Demo" | "Learn more" |

---

## 7. Banned Phrases (Zero Tolerance — All Channels)

```
"excited to share"         "game-changer"           "synergy"
"circle back"              "excited to announce"     "thrilled to share"
"innovative solution"      "I wanted to reach out"  "Hope this finds you well"
"Just following up"        "Quick question"          "Touch base"
"We help companies like yours"  "disruptive"         "bleeding edge"
"leverage"                 "paradigm shift"          "scalable solution"
"deep dive"                "move the needle"         "low-hanging fruit"
```

---

## 8. Channel-Specific Rules

### LinkedIn
- Hook on line 1: a number, counterintuitive claim, or direct question
- Length: 150–300 words
- Format: short paragraphs (1–3 lines), mobile-first
- Emojis: max 3 per post
- CTA: one per post (no double CTAs)
- Style: first-person, specific, narrative or data-driven

### Instagram
- Length: 80–150 word captions
- Format: visual-first — copy supports the image
- Emojis: max 3 per post
- Hook: first line must stand alone (truncated preview)

### Email / DM Outreach
- Opening: pain-first — reference their problem, not our service
- Specificity: must mention something specific about the prospect (post, product, recent funding)
- Length: ≤150 words for cold outreach; ≤500 words for proposals
- CTA: one ask per message
- First touch: no attachments; links to calendly only on second+ contact
- Banned openers: see §7

### Website Copy
- Headline: outcome-focused ("Build your SaaS in 5 days" not "We offer development services")
- Primary CTA: "Book a Demo"
- Secondary CTA: "Get in Touch" / "Discuss Your AI Agent Project"
- Language: partner, not vendor
- Social proof: delivery speed + working code emphasis

### Telegram (internal ops)
- Concise, action-oriented updates
- HITL approvals: state exactly what is being approved, one approve/reject per message
- Status updates: bullet format, no filler

---

## 9. Token Economy Rules (Baked Into Every Output)

Every brand output — content, copy, campaign — must follow the cheapest viable path:

```
1. Deterministic?      → Use a template + variable fill (no AI needed)
2. Local model free?   → Ollama qwen2.5:7b for template filling, JSON extraction, classification
3. Redis cache hit?    → Return cached output, skip cloud call entirely
4. nano tier?          → gemini-flash-lite for formatting, captions, subject lines
5. md tier?            → gemini-flash for full draft generation, research
6. CEO/critic tier?    → claude-sonnet for final critique, architecture, decisions only
```

**Content batching rule**: Generate 1 week of social posts in a single LLM call, not 7 separate calls. Store batch in Redis with 7-day TTL.

**Template promotion**: When a content template wins A/B test → promote to turicks-brain as permanent template → future generation uses Ollama fill (free) instead of cloud generation.

**Brand voice consistency reduces API spend**: Fewer revision loops = fewer critic calls = lower cost.

---

## 10. Visual Identity

> Hex codes TBD — extract from turicks.com CSS stylesheet when Figma access available.

| Element | Current Assessment |
|---|---|
| **Aesthetic** | Modern, clean SaaS — professional hierarchy |
| **Color palette** | Dark + accent (typical AI/tech SaaS) — confirm exact hex |
| **Typography** | Contemporary sans-serif — confirm font-family from CSS |
| **Logo usage** | Wordmark primary; confirm safe zone and minimum size from brand kit |
| **Imagery** | Clean product screenshots, minimal illustration, no stock photos |

---

## 11. Team

**Effectively solo (2026):** Pushkar Verma — founder, FounderOS architect, delivery + design craft.

Historical team references in older collateral are superseded. See ADR-032.

---

## 12. What Turicks Is NOT

- Not a freelancer marketplace
- Not a low-cost offshore dev shop
- Not a consulting firm that writes requirements docs
- Not a "we'll get back to you in 2 weeks" agency

**We are**: a small, AI-native team that moves at startup speed and delivers production code, not slide decks.
