# Demo Morning — Overnight Runbook (2026-06-18)

> **Goal:** Walk into the meeting with a live FounderOS demo, web-design routing proof, and GTM assets ready to execute.
> **Evidence bar:** `/health` up · `pnpm eval:webdesign` 10/10 · one real Telegram HITL approve path · copy-paste marketing below.

---

## Part 1 — Ops (VPS, ~20 min)

### A. Deploy latest `main` (if not already)

```bash
ssh founderos@95.217.162.12
cd /opt/founderos
git fetch origin main
git checkout main && git reset --hard origin/main
pnpm install --frozen-lockfile
pnpm run setup
pnpm build
sudo systemctl restart founderos
curl -s localhost:3001/health | python3 -m json.tool
```

### B. Fix dead OpenRouter model (P0 — caused eval 6/10)

```bash
cd /opt/founderos
chmod +x scripts/vps-fix-agent-model.sh
bash scripts/vps-fix-agent-model.sh
# Or manual:
# sed -i 's|AGENT_MODEL=openrouter:google/gemini-2.5-flash-preview-05-20|AGENT_MODEL=openrouter:google/gemini-2.5-flash|' .env
# sudo systemctl restart founderos
```

### C. Verify web-design wiring (on `main` after deploy)

```bash
pnpm eval:webdesign        # expect 10/10
pnpm eval:webdesign:hitl   # expect HITL clears after one approve
pnpm test:smoke:miso       # MISO/JARVIS live path
```

### D. Known degraded (non-blocking for demo)

| Check | Status | Demo workaround |
|-------|--------|-----------------|
| Gmail `degraded` | Composio probe broken | Use **HITL email draft** — show card, tap Reject if you don't want to send |
| Claude spend limit | `claude -p` fails | Show **engineering HITL card** for build task; explain CLI limit; don't approve live build |
| Ollama/RAG empty | Optional | Research uses `search_web` (DuckDuckGo fallback) |

### E. Git ownership (one-time)

```bash
sudo chown -R founderos:founderos /opt/founderos
```

---

## Part 2 — Software demo (Telegram, ~15 min live)

### Setup

1. Open Telegram → FounderOS bot
2. `/reset` if thread was wedged
3. Confirm `/health` or `/status` shows database up

### Track A — FounderOS core (5 min) — from `DEMO-SCRIPT.md`

| # | You type | What to say |
|---|----------|-------------|
| 1 | `What's the latest news about AI coding tools this week?` | Research, read-only, instant |
| 2 | `List the files in my Projects folder` | Personal, path-guarded laptop ops |
| 3 | `Write a TypeScript function to parse an ISO date string and return a formatted date` | Engineering inline code, no API |
| 4 | `Draft an email to hello@acme.com introducing Turicks and asking for a discovery call` | **HITL hero** — show card, Approve or Reject |
| 5 | `Open https://anthropic.com in my Safari browser` | Personal browser, HITL-gated |

**Close:** *"Seven departments, one approval gate, idempotent audit log. Temperature zero. This runs Turicks delivery."*

### Track B — Web Design Service (3 min)

| # | You type | Expected route |
|---|----------|----------------|
| 1 | `Find leads for cinematic launch sites — AI dev-tool startups in Europe` | **research** → `search_web` |
| 2 | `Proof Drop outreach to Langfuse about their launch site` | **sales** → `send_email` HITL |
| 3 | `Build a cinematic landing page for AgentOps using the neon preset` | **engineering** → `claude_code` HITL |

**Close:** *"Signals `design_brief_ready` and `site_deployed` fire scheduler nudges. Proof Drop → sales follow-up is wired."*

---

## Part 3 — Marketing (copy-paste ready)

### Proof Drop email (≤150 words)

**Subject:** Langfuse launch page — one fix

Langfuse team,

Your in-product observability UI is strong, but the homepage doesn't signal the depth of what Langfuse does for agent builders.

I built a custom launch hero to show what a cinematic first impression could look like:

https://proof.turicks.com/drops/langfuse

Turicks is The Autonomous Studio — launch experiences for AI/dev-tool startups, delivered through FounderOS (production multi-agent OS with human approval on every external action). Cinematic Launch Experience from $8K.

Worth a 20-minute call to walk through it?

Pushkar, Turicks

---

### LinkedIn BUILD_LOG post

**1,098 tests. One launch page.**

Most AI agent projects ship a chatbot wrapper.

We're building proof that governed delivery + cinematic design can coexist.

Showcase 1 is live: AgentOps — a fictional AI observability platform with dark terminal aesthetic, scroll-driven narrative, and a HITL approval UI from our real FounderOS audit trail.

Not a mockup deck. A deployed launch experience.

Built on cinematic-web presets. Delivered through FounderOS — LangGraph multi-agent OS where every external action pauses for founder approval.

Real numbers:
→ 1,098+ tests green
→ Eval harness: routing + tool selection + HITL
→ Idempotent audit log — same action can't fire twice

See it: https://proof.turicks.com/showcase-1

Turicks is The Autonomous Studio for AI/dev-tool startups.

Launching or re-launching? Reply or DM — 20 minutes, no pitch deck.

---

### 3 showcase concepts (proof.turicks.com)

1. **AgentOps Launch** — fictional agent observability · dark/terminal · `proof.turicks.com/showcase-1`
2. **VectorDB Launch** — fictional vector DB for RAG · clean technical · showcase-2
3. **FounderOS Studio** — Turicks meta landing · cinematic · primary Awwwards target · showcase-3

---

### Gumroad (manual tonight if time — packs at repo root `gumroad-packs/`)

| Product | Price |
|---------|-------|
| cinematic-web Cinematic Premium Pack | $29 |
| Prospecting & ICP Scoring Pack | $19 |
| Brand-Voice Critique Kit | $14 |
| LangGraph Multi-Agent Starter | $34 |

Create at gumroad.com → upload zips → link on turicks.com `/products`.

---

## Part 4 — Morning meeting agenda (30 min)

| Time | Topic |
|------|-------|
| 0–5 | Live Telegram: Track A queries 1–3 |
| 5–10 | HITL email card (query 4) |
| 10–15 | Web design routing (Track B) |
| 15–20 | Architecture slide: supervisor → 7 depts → HITL → audit |
| 20–25 | GTM: Proof Drop + LinkedIn post + showcase URLs |
| 25–30 | Next: promote stable, Claude limit, GWS Gmail, showcase deploy |

---

## Part 5 — Founder actions only you can do

1. **Raise Claude spend limit** — [claude.ai/settings/usage](https://claude.ai/settings/usage) (blocks live `claude_code` builds)
2. **Approve PR** `cursor/demo-morning-prep-cb8b` → merge → CD deploys model fix
3. **Optional:** Install `gws` CLI on VPS for Gmail (ADR-029) or accept degraded until post-demo
4. **Optional:** Deploy showcase-1 static site to proof.turicks.com (engineering/claude after limit fixed)

---

## Evidence checklist (print this)

- [ ] `curl localhost:3001/health` → database up
- [ ] `pnpm eval:webdesign` → 10/10
- [ ] Telegram query 4 → HITL card appears
- [ ] Track B query 3 → engineering + claude_code HITL
- [ ] LinkedIn post drafted (paste above)
- [ ] One Proof Drop email ready (personalize company name)
