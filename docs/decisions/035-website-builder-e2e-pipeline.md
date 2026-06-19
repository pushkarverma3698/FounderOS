# ADR-035: Website Builder E2E Pipeline

**Date:** 2026-06-19  
**Status:** Accepted

## Context

The cinematic-web / website builder product required a true end-to-end path:
preset scaffold → customized landing → public deploy → sales signal. Prior state:
- `claude_code` improvised "neon vibe" pages with no preset files
- `deploy_static_site` existed but was often skipped by the model
- Proof Drop workflow produced concept briefs only, not live URLs
- No deterministic bridge to the external `Website-Builder-Tool` repo

## Decision

Ship a **3-step engineering pipeline** with deterministic preset copy:

| Step | Tool | HITL |
|------|------|------|
| 1 | `apply_cinematic_preset` | No |
| 2 | `claude_code` (customize scaffold) | Yes |
| 3 | `deploy_static_site` | Yes |

### Implementation

1. **Bundled presets** — `assets/cinematic-presets/{neon,glass,terminal,minimal}/` (offline E2E)
2. **External override** — `CINEMATIC_WEB_PRESETS_ROOT` points at cloned Website-Builder-Tool presets
3. **Pure functions** — `src/agents/cinematic-build.ts` parses requests + builds pre-router pipeline directive
4. **Workflow** — `web_build` + `/webbuild Client preset slug` Telegram command
5. **Proof Drop** — added `build_site` step for `hero_redesign` artifacts

## Consequences

- Engineering gains one new read-only tool (6-layer wiring complete)
- Pre-router injects full pipeline directive for cinematic build prompts
- Eval golden task `webdesign-build-and-deploy` expects tools through first HITL only
- VPS still requires: nginx, `STATIC_SITE_PUBLIC_BASE_URL`, `claude login`, optional passwordless sudo

## Verification

```bash
pnpm test tests/unit/tools/cinematic-preset.test.ts tests/unit/agents/cinematic-build.test.ts
pnpm eval:webdesign:full   # preset → deploy, no LLM
pnpm eval:webdesign         # routing + contracts + DB (live model; flaky on free tier)
```
