# Video Factory — Brand Registry

One directory per client (or own brand). Each `brand.json` is validated against
the Zod schema in `src/tools/video-brand.ts` — the schema is the contract; a
malformed brand file is a typed failure, never a silent guess (FounderOS rule:
fix the schema, not the code).

```
brands/
├── <slug>/
│   ├── brand.json     # tokens: palette, typography, tone, copy, CTA, video prefs
│   ├── DESIGN.md      # optional camera-direction cheat sheet (frame.md style)
│   └── assets/        # logo, reference stills for Veo b-roll (optional)
```

`brand.json` drives N videos: the brief compiler (`src/tools/video-brief.ts`)
turns `(brand, request)` into a deterministic production brief for any format
(hero 16:9, reel 9:16, square 1:1). Same brand + same request → identical brief.

## Onboarding a new client (15 minutes)
1. `cp -r brands/_template brands/<client-slug>` (or copy `the-health-place`).
2. Fill palette/typography/tone from the client's site; put unverified facts
   (canonical name, logo) behind `"confirmed": false` flags until the client signs off.
3. Drop the logo + any reference stills into `assets/`.
4. Validate: `pnpm test -- video-brand` (schema test loads every brand dir).
5. The kernel can now plan videos for the client by slug.
