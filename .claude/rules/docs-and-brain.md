---
paths:
  - "docs/**"
  - "scripts/sync-turicks-brain.ts"
---

# Docs and brain sync

- Brain sync runs on the VPS: nightly (`.github/workflows/brain-sync.yml`) and on demand with `gh workflow run brain-sync.yml`. After a `docs/` change merges, trigger it once.
- `pnpm brain:sync` refuses to run anywhere but `founder-os`. A laptop run once printed `✅ Sync complete` after writing a local database nobody reads. `--local` allows it for testing and labels the output LOCAL.
- Every synced row carries a project (`founderos`, or `turicks` for the brand guide). Keep secrets and personal data (UPI ids, phones, keys) out of brain rows.
- To retire a plan from search, put `**Status:** Superseded by <newer plan>` (or `Archived`) in its first 20 lines and merge; the next brain sync marks its chunks SUPERSEDED/ARCHIVED and search stops returning them. "Supersedes" in a newer plan's header does not count. Dated files (`YYYY-MM-DD-*.md`) also rank lower as they age: 30% less after 90 days, never below that.
- Plans go to `docs/plans/YYYY-MM-DD-<feature>.md`; session notes to `docs/sessions/YYYY-MM-DD-<topic>.md` from `docs/sessions/TEMPLATE.md`.
