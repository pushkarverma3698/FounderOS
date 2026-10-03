---
paths:
  - "video-factory/**"
  - "src/tools/video-*.ts"
---

# Video factory

`video-factory/` is the client social-video engine: a standalone npm directory, not in the pnpm workspace. It holds the `brands/` registry, `projects/`, and `scripts/produce.mjs` (a receipt-checkpointed executor).

The kernel side is `src/tools/video-{brand,brief,shotlist,models,compose,production,title-card}.ts`: pure and $0. See `docs/VIDEO-FACTORY.md` and `docs/VIDEO-PIPELINE-AUDIT.md`.
