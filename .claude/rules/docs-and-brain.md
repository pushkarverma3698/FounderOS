---
paths:
  - "docs/**"
  - "scripts/sync-turicks-brain.ts"
---

# Docs and brain sync

- Brain sync runs on the VPS: nightly (`.github/workflows/brain-sync.yml`) and on demand with `gh workflow run brain-sync.yml`. After a `docs/` change merges, trigger it once.
- `pnpm brain:sync` refuses to run anywhere but `founder-os`. A laptop run once printed `✅ Sync complete` after writing a local database nobody reads. `--local` allows it for testing and labels the output LOCAL.
- Every synced row carries a project (`founderos`, or `turicks` for the brand guide). Keep secrets and personal data (UPI ids, phones, keys) out of brain rows.
- Plans go to `docs/plans/YYYY-MM-DD-<feature>.md`; session notes to `docs/sessions/YYYY-MM-DD-<topic>.md` from `docs/sessions/TEMPLATE.md`.
