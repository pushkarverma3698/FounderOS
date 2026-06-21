# JARVIS Cinematic — Next.js Command Center

Film-grade HUD for FounderOS. Connects to the same `/api/v1/*` web gateway as the Vite JARVIS app.

## Stack

- **Next.js 15** (App Router)
- **React Three Fiber** — 3D core orb, orbiting department nodes, bloom + vignette
- **Framer Motion** — boot sequence, panel transitions
- **Web Speech API** — voice commands + JARVIS-style TTS on replies

## Run locally (your machine)

**One command — fixes pull conflicts, frees ports, verifies, then starts:**

```bash
git checkout cursor/jarvis-nextjs-cinematic-ae51
pnpm jarvis:doctor --fix
pnpm dev:jarvis-local
```

Doctor resets a conflicting local `src/agents/agent-tools/rag.ts` (needs `rag-orchestrator.ts` from this branch).

Or step by step:

```bash
pnpm install
cp .env.example .env   # add GOOGLE_GENERATIVE_AI_API_KEY + DATABASE_URL
pnpm run setup         # Postgres migrations
pnpm dev:jarvis-local  # → http://localhost:3000
pnpm verify:jarvis     # preflight: office compile + gateway + production build
```

Or two terminals:

```bash
pnpm dev:jarvis-gateway   # :3001 — no Telegram poll
pnpm dev:jarvis-next      # :3000
```

Open **http://localhost:3000** in your browser (not the cloud VPS port forward).

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| `400 ... is not a valid model ID` | Set `AGENT_MODEL=google-genai:gemini-2.5-flash` in `.env` (retired `preview-05-20` ids are auto-normalized on latest branch) |
| `NEURAL LINK` shows OFFLINE | Gateway must be on `:3001`; SSE connects directly to `http://127.0.0.1:3001` (not the Next proxy) |
| `Transmission failed` | Run `pnpm dev:jarvis-gateway` or use `pnpm dev:jarvis-local` |
| Red errors in console for `/stream` | Pull latest — SSE proxy hang-up fix + CORS on gateway |

## Environment

Optional: `JARVIS_GATEWAY_URL` (default `http://127.0.0.1:3001`) for API proxy in `next.config.ts`.

## Design

| Layer | Purpose |
|-------|---------|
| Boot intro | Cinematic "neural link" sequence |
| 3D scene | Distorted sphere + rings + dept satellites |
| HUD | Glass panels, scanlines, film grain |
| Voice | Mic → speech recognition; replies → TTS |

Legacy Vite UI remains at `apps/jarvis` until this is promoted.
