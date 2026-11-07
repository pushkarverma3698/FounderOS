---
paths:
  - "video-factory/**"
---

# Video factory

`video-factory/` is the client social-video engine: a standalone npm directory, not in the pnpm workspace. It holds the `brands/` registry, `projects/`, and `scripts/produce.mjs` (a receipt-checkpointed executor).

The `src/tools/video-*` side was removed with the kernel (2026-10-10). See `docs/VIDEO-FACTORY.md` and `docs/VIDEO-PIPELINE-AUDIT.md`.
